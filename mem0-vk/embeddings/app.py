"""
mem0-vk embeddings + graph container.

FastAPI service providing:
  • /v1/embeddings  — OpenAI-format embeddings via sentence-transformers (CPU)
  • /graph/*        — in-memory NetworkX graph (one graph per user_id)
  • /health         — liveness + loaded model info

The mem0-vk Node server calls this as its "local" embedding backend
(EMBED_LOCAL_URL) and, when GRAPH_URL is set, as the graph store.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any

import fastapi
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer
from starlette.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embeddings")

MODEL_NAME = os.environ.get("ST_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
PORT = int(os.environ.get("PORT", "8001"))
# Directory where per-user graphs are persisted as GraphML files
# (`<user_id>.graphml`). Mount a volume here to survive container restarts.
GRAPH_DIR = os.environ.get("GRAPH_DIR", "/data/graphs")

app = FastAPI(title="mem0-vk embeddings + graph", version="1.0.0")

# ── Model ─────────────────────────────────────────────────────────────────────

_model: SentenceTransformer | None = None
_model_lock = threading.Lock()


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                log.info("loading %s (CPU)…", MODEL_NAME)
                _model = SentenceTransformer(MODEL_NAME, device="cpu")
                log.info("model loaded: dim=%d", _model.get_sentence_embedding_dimension())
    return _model


def dim() -> int:
    return int(get_model().get_sentence_embedding_dimension())


# ── Embeddings (OpenAI-compatible) ────────────────────────────────────────────

class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str | None = None


class EmbeddingData(BaseModel):
    object: str = "embedding"
    index: int
    embedding: list[float]


class EmbedResponse(BaseModel):
    object: str = "list"
    data: list[EmbeddingData]
    model: str
    usage: dict[str, int]


@app.get("/v1/models")
def list_models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.post("/v1/embeddings", response_model=EmbedResponse)
def embeddings(req: EmbedRequest):
    model = get_model()
    texts = [req.input] if isinstance(req.input, str) else req.input
    vectors = model.encode([t for t in texts], normalize_embeddings=True)
    return EmbedResponse(
        data=[EmbeddingData(index=i, embedding=[float(x) for x in v]) for i, v in enumerate(vectors)],
        model=MODEL_NAME,
        usage={"prompt_tokens": 0, "total_tokens": 0},
    )


# ── Graph (NetworkX, in-memory, one DiGraph per user_id) ─────────────────────

class Entity(BaseModel):
    name: str
    type: str = "other"
    description: str = ""


class Relation(BaseModel):
    subject: str
    predicate: str
    object: str


class UpsertRequest(BaseModel):
    user_id: str
    entities: list[Entity] = Field(default_factory=list)
    relations: list[Relation] = Field(default_factory=list)
    # Calling workspace's HEAD commit when this upsert happened (best-effort,
    # resolved by the VK API — mem0-vk/embeddings has no git access itself).
    # Stored as last-write-wins on every node/edge touched by this upsert, so
    # a later staleness check can ask "is this still the code as of the
    # commit this fact was true for" — see
    # docs/ADR/ADR-030-mem0-context-drift-measurement.md.
    commit_sha: str | None = None


class QueryRequest(BaseModel):
    user_id: str
    query: str = ""


class TraverseRequest(BaseModel):
    user_id: str
    # Substring match (same rule as /graph/neighbors) against node name or
    # description, to find the starting node(s) for the BFS below.
    start: str
    hops: int = 2
    # "out" = follow subject->object edges only (what depends ON start);
    # "in" = follow object->subject edges only (what start depends on);
    # "both" = either direction. The graph is directed (subject->object per
    # relation), so "out"/"in" are NOT symmetric — pick deliberately.
    direction: str = "both"


class RemoveNodeRequest(BaseModel):
    node_id: str


class RemoveUserRequest(BaseModel):
    user_id: str


@dataclass
class GraphStore:
    graphs: dict[str, Any] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def get(self, user_id: str):
        import networkx as nx

        with self.lock:
            g = self.graphs.get(user_id)
            if g is None:
                g = self._load(user_id) or nx.DiGraph()
                self.graphs[user_id] = g
            return g

    def _path(self, user_id: str) -> str:
        import re as _re

        safe = _re.sub(r"[^A-Za-z0-9._-]", "_", user_id) or "default"
        return os.path.join(GRAPH_DIR, f"{safe}.graphml")

    def _load(self, user_id: str):
        import networkx as nx

        path = self._path(user_id)
        try:
            if os.path.exists(path):
                log.info("loading graph from %s", path)
                return nx.read_graphml(path)
        except Exception as e:  # noqa: BLE001
            log.error("failed to load graph %s: %s", path, e)
        return None

    def _persist(self, user_id: str) -> None:
        import networkx as nx

        g = self.graphs.get(user_id)
        if g is None:
            return
        try:
            os.makedirs(GRAPH_DIR, exist_ok=True)
            nx.write_graphml(g, self._path(user_id))
        except Exception as e:  # noqa: BLE001
            log.error("failed to persist graph %s: %s", user_id, e)

    def upsert(self, user_id: str, req: "UpsertRequest") -> dict:
        import networkx as nx

        g = self.get(user_id)
        # Last-write-wins: every node/edge touched by THIS upsert call is
        # stamped with req.commit_sha (if given), overwriting whatever was
        # there before — a node accumulated across many calls at different
        # commits keeps only the most recent one it was reinforced at. A
        # missing commit_sha (best-effort on the caller's side) leaves any
        # existing stamp untouched rather than clearing it to None.
        added_nodes = 0
        for e in req.entities:
            name = _norm(e.name)
            if not name:
                continue
            if g.has_node(name):
                g.nodes[name].setdefault("description", "")
                if e.description:
                    g.nodes[name]["description"] = e.description
            else:
                g.add_node(name, type=e.type, description=e.description)
                added_nodes += 1
            if req.commit_sha:
                g.nodes[name]["commit_sha"] = req.commit_sha
        added_edges = 0
        for r in req.relations:
            s, o = _norm(r.subject), _norm(r.object)
            if not s or not o:
                continue
            if not g.has_node(s):
                g.add_node(s, type="other", description="")
            if not g.has_node(o):
                g.add_node(o, type="other", description="")
            if req.commit_sha:
                g.nodes[s]["commit_sha"] = req.commit_sha
                g.nodes[o]["commit_sha"] = req.commit_sha
            if not g.has_edge(s, o):
                g.add_edge(s, o, predicate=r.predicate)
                added_edges += 1
            else:
                g[s][o]["predicate"] = r.predicate
            if req.commit_sha:
                g[s][o]["commit_sha"] = req.commit_sha
        self._persist(user_id)
        return {"ok": True, "user_id": user_id, "nodes_added": added_nodes, "edges_added": added_edges}

    def remove_user(self, user_id: str) -> dict:
        with self.lock:
            g = self.graphs.pop(user_id, None)
            n = g.number_of_nodes() if g else 0
        try:
            path = self._path(user_id)
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:  # noqa: BLE001
            log.error("failed to delete graph file %s: %s", user_id, e)
        return {"ok": True, "removed": g is not None, "nodes": n}


graph = GraphStore()


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip())


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "dim": dim(), "users": len(graph.graphs)}


@app.get("/graph/stats")
def graph_stats(user_id: str | None = None):
    if user_id:
        g = graph.get(user_id)
        return {"user_id": user_id, "nodes": g.number_of_nodes(), "edges": g.number_of_edges()}
    return {
        "users": [
            {"user_id": u, "nodes": g.number_of_nodes(), "edges": g.number_of_edges()}
            for u, g in graph.graphs.items()
        ]
    }


@app.get("/graph/overview")
def graph_overview(user_id: str, limit: int = 80):
    """A bounded, render-ready view of one memory graph.

    This deliberately returns relations, not vector payloads.  The vector
    store remains private to mem0-vk while the UI can safely render the ideas
    and their extracted links as a force-directed network.
    """
    g = graph.get(user_id)
    capped_limit = max(1, min(limit, 160))
    # Prefer the most connected concepts when a repository has a large graph;
    # this retains the useful structure instead of returning insertion order.
    node_ids = sorted(g.nodes, key=lambda node: (-g.degree(node), str(node)))[:capped_limit]
    node_set = set(node_ids)
    nodes = [
        {
            "id": node,
            "type": g.nodes[node].get("type", "other"),
            "description": g.nodes[node].get("description", ""),
            "degree": g.degree(node),
        }
        for node in node_ids
    ]
    edges = [
        {
            "subject": subject,
            "predicate": attrs.get("predicate", "related_to"),
            "object": obj,
        }
        for subject, obj, attrs in g.edges(data=True)
        if subject in node_set and obj in node_set
    ]
    return {
        "user_id": user_id,
        "nodes": nodes,
        "edges": edges,
        "truncated": g.number_of_nodes() > len(node_ids),
    }


@app.post("/graph/upsert")
def graph_upsert(req: UpsertRequest):
    return graph.upsert(req.user_id, req)


@app.post("/graph/neighbors")
def graph_neighbors(req: QueryRequest):
    g = graph.get(req.user_id)
    q = _norm(req.query).lower()
    out = []
    for name, attrs in g.nodes(data=True):
        if not q or q in name.lower() or q in (attrs.get("description") or "").lower():
            out.append({"id": name, "name": name, "type": attrs.get("type", "other"), "description": attrs.get("description", "")})
    # expand one hop from matched nodes
    matched = {n["id"] for n in out}
    seen = set(matched)
    for n in list(out):
        for nb in g.neighbors(n["id"]):
            if nb not in seen:
                seen.add(nb)
                a = g.nodes[nb]
                out.append({"id": nb, "name": nb, "type": a.get("type", "other"), "description": a.get("description", "")})
    return {"user_id": req.user_id, "neighbors": out}


@app.post("/graph/traverse")
def graph_traverse(req: TraverseRequest):
    """Real multi-hop BFS from a matched starting node, unlike /graph/neighbors
    (substring match + one hop of successors only, no depth/direction
    control). Caps at MAX_HOPS and MAX_NODES so a broad `start` match can't
    flood the caller's context — mirrors the DEFAULT_SEARCH_LIMIT rationale
    in crates/mcp/src/task_server/tools/mem0.rs (ADR-028)."""
    MAX_HOPS = 3
    MAX_NODES = 40

    g = graph.get(req.user_id)
    hops = max(1, min(req.hops, MAX_HOPS))
    q = _norm(req.start).lower()
    start_nodes = [
        n
        for n, attrs in g.nodes(data=True)
        if q and (q in n.lower() or q in (attrs.get("description") or "").lower())
    ]
    if not start_nodes:
        return {
            "user_id": req.user_id,
            "start": req.start,
            "matched_start_nodes": [],
            "hops": hops,
            "nodes": [],
            "edges": [],
            "truncated": False,
        }

    visited: set[str] = set(start_nodes)
    frontier: set[str] = set(start_nodes)
    for _ in range(hops):
        next_frontier: set[str] = set()
        for n in frontier:
            if req.direction in ("out", "both"):
                next_frontier.update(g.successors(n))
            if req.direction in ("in", "both"):
                next_frontier.update(g.predecessors(n))
        next_frontier -= visited
        if not next_frontier:
            break
        visited |= next_frontier
        frontier = next_frontier

    truncated = len(visited) > MAX_NODES
    node_list = list(visited)[:MAX_NODES]
    node_set = set(node_list)
    nodes_out = [
        {
            "id": n,
            "type": g.nodes[n].get("type", "other"),
            "description": g.nodes[n].get("description", ""),
            # Last commit this node was reinforced/created at, if the caller
            # supplied one at upsert time — a staleness check's raw input,
            # not yet acted on by this endpoint. May be absent for older
            # facts saved before commit_sha tracking existed.
            "commit_sha": g.nodes[n].get("commit_sha"),
        }
        for n in node_list
    ]
    edges_out = [
        {
            "subject": s,
            "predicate": attrs.get("predicate", "related_to"),
            "object": o,
            "commit_sha": attrs.get("commit_sha"),
        }
        for s, o, attrs in g.edges(data=True)
        if s in node_set and o in node_set
    ]
    return {
        "user_id": req.user_id,
        "start": req.start,
        "matched_start_nodes": start_nodes,
        "hops": hops,
        "nodes": nodes_out,
        "edges": edges_out,
        "truncated": truncated,
    }


@app.post("/graph/relations")
def graph_relations(req: QueryRequest):
    g = graph.get(req.user_id)
    q = _norm(req.query).lower()
    out = []
    for (s, o, attrs) in g.edges(data=True):
        hay = f"{s} {o} {attrs.get('predicate', '')}".lower()
        if not q or q in hay:
            out.append({"subject": s, "predicate": attrs.get("predicate", "related_to"), "object": o})
    return {"user_id": req.user_id, "relations": out}


@app.post("/graph/remove_node")
def graph_remove_node(req: RemoveNodeRequest):
    for g in list(graph.graphs.values()):
        if g.has_node(req.node_id):
            g.remove_node(req.node_id)
    return {"ok": True}


@app.post("/graph/remove_user")
def graph_remove_user(req: RemoveUserRequest):
    return graph.remove_user(req.user_id)


if __name__ == "__main__":
    import uvicorn

    get_model()  # preload at startup so /health reports dim without a first request
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
