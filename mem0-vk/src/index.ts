#!/usr/bin/env node
/**
 * mem0-vk — Universal MCP + REST memory server (graph-capable).
 *
 * Single Node.js backend that exposes:
 *   • MCP Streamable-HTTP on POST/GET/DELETE /mcp
 *   • REST API on /api/* (for hosts that cannot do MCP-over-HTTP, e.g. Codex)
 *
 * Both serve the SAME Qdrant-backed memory, partitioned by `user_id`
 * (the caller passes the repo slug / project id on every call — see AGENTS.md).
 *
 * Architecture (multi-container):
 *   [This container "mem0-vk" (Node)]  ← what this file implements
 *        ▲
 *        │  /v1/embeddings  (OpenAI-format, for the local Python container)
 *        ▼
 *   [Python container: sentence-transformers (CPU) + NetworkX graph]
 *
 *   This container also talks to:
 *        • Qdrant (vectors)          — QDRANT_URL
 *        • Extraction LLM            — MEM0_LLM_PROVIDER = groq | openrouter | llama
 *        • Fallback embeddings       — OpenAI, OpenRouter, llama-server (see below)
 *
 * Embedding resolution order (first success wins, first failure falls through):
 *   1. local  (sentence-transformers container)  — EMBED_LOCAL_URL
 *   2. llama  (llama-server /v1/embeddings)      — EMBED_LLAMA_URL / EMBED_LLAMA_KEY / EMBED_LLAMA_MODEL
 *   3. openai (api.openai.com /v1/embeddings)    — OPENAI_API_KEY / EMBED_OPENAI_MODEL
 *   4. openrouter (openrouter.ai /v1/embeddings) — EMBED_OPENROUTER_KEY / EMBED_OPENROUTER_MODEL
 *
 * The Qdrant collection's vector `size` MUST match the dimension of whichever
 * backend actually wins. Set EMBED_DIM (default 768, for nomic-embed-text) and
 * recreate the Qdrant volume if you change the local embedding model.
 *
 * Graph (NetworkX):
 *   When GRAPH_URL is set, memory_store will ALSO extract entities + relations
 *   via the LLM and push them to the Python container's /graph/* endpoints.
 *   memory_search returns graph neighbors alongside vector hits.
 *   The graph itself lives in the Python container; Node only proxies.
 *
 * Environment variables:
 *   PORT                        — HTTP port (default 8000)
 *   QDRANT_URL                  — default http://qdrant:6333
 *   MEM0_COLLECTION             — default "mem0-vk"
 *   MEM0_DEFAULT_USER           — default "default"
 *
 *   EMBED_DIM                   — vector dimension (default 768)
 *   EMBED_LOCAL_URL             — OpenAI-format base for the local st container
 *                                  e.g. http://embeddings:8001/v1
 *   EMBED_LOCAL_MODEL           — default "sentence-transformers" (ignored by most)
 *   EMBED_LLAMA_URL             — e.g. http://192.168.1.10:8080/v1
 *   EMBED_LLAMA_KEY             — optional
 *   EMBED_LLAMA_MODEL           — e.g. nomic-embed-text-v1.5
 *   OPENAI_API_KEY              — required only if openai fallback is used
 *   EMBED_OPENAI_MODEL          — default "text-embedding-3-small"
 *   EMBED_OPENROUTER_KEY        — required only if openrouter fallback is used
 *   EMBED_OPENROUTER_MODEL      — default "nvidia/llama-3.2-nv-embed:free"
 *
 *   MEM0_LLM_PROVIDER           — groq | openrouter | llama (default groq)
 *   GROQ_API_KEY                — required if provider=groq
 *   GROQ_MODEL                  — default "llama-3.3-70b-versatile"
 *   MEM0_OPENROUTER_KEY         — required if provider=openrouter
 *   MEM0_OPENROUTER_MODEL       — default "nvidia/nemotron-3-nano-30b-a3b:free"
 *   MEM0_LLAMA_URL              — required if provider=llama (OpenAI base, e.g. http://host:8080/v1)
 *   MEM0_LLAMA_KEY              — optional
 *   MEM0_LLAMA_MODEL            — required if provider=llama
 *
 *   GRAPH_URL                   — base for the Python container's graph API
 *                                  (e.g. http://embeddings:8001) — omit to disable graph
 *
 *   HOST                        — bind address (default 0.0.0.0)
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { timingSafeEqual } from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────

type LLMProvider = "groq" | "openrouter" | "llama" | "openai";

const config = {
  port: parseInt(process.env.PORT || "8000", 10),
  host: process.env.HOST || "0.0.0.0",

  qdrantUrl: (process.env.QDRANT_URL || "http://qdrant:6333").replace(/\/$/, ""),
  collection: process.env.MEM0_COLLECTION || "mem0-vk",
  defaultUser: process.env.MEM0_DEFAULT_USER || "default",

  embedDim: parseInt(process.env.EMBED_DIM || "768", 10),

  embed: {
    local: {
      url: process.env.EMBED_LOCAL_URL || "",
      model: process.env.EMBED_LOCAL_MODEL || "sentence-transformers",
      key: process.env.EMBED_LOCAL_KEY || "",
    },
    llama: {
      url: process.env.EMBED_LLAMA_URL || "",
      model: process.env.EMBED_LLAMA_MODEL || "",
      key: process.env.EMBED_LLAMA_KEY || "",
    },
    openai: {
      url: process.env.EMBED_OPENAI_URL || "https://api.openai.com/v1",
      model: process.env.EMBED_OPENAI_MODEL || "text-embedding-3-small",
      key: process.env.OPENAI_API_KEY || "",
    },
    openrouter: {
      url: process.env.EMBED_OPENROUTER_URL || "https://openrouter.ai/api/v1",
      model: process.env.EMBED_OPENROUTER_MODEL || "nvidia/llama-3.2-nv-embed:free",
      key: process.env.EMBED_OPENROUTER_KEY || "",
    },
  },

  llm: {
    provider: (process.env.MEM0_LLM_PROVIDER || "groq").toLowerCase() as LLMProvider,
    groq: {
      url: process.env.GROQ_URL || "https://api.groq.com/openai/v1",
      key: process.env.GROQ_API_KEY || "",
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    },
    openrouter: {
      url: process.env.MEM0_OPENROUTER_URL || "https://openrouter.ai/api/v1",
      key: process.env.MEM0_OPENROUTER_KEY || "",
      model:
        process.env.MEM0_OPENROUTER_MODEL || "z-ai/glm-5.2:free",
    },
    llama: {
      url: process.env.MEM0_LLAMA_URL || "",
      key: process.env.MEM0_LLAMA_KEY || "",
      model: process.env.MEM0_LLAMA_MODEL || "",
    },
    // Generic OpenAI-compatible endpoint — reuse any paid key from your CLIs
    // (DeepSeek, NVIDIA, OpenRouter paid, OpenAI, …). Set MEM0_OPENAI_URL to
    // the provider's base (e.g. https://api.deepseek.com/v1).
    openai: {
      url: process.env.MEM0_OPENAI_URL || "",
      key: process.env.MEM0_OPENAI_KEY || "",
      model: process.env.MEM0_OPENAI_MODEL || "",
    },
  },

  graphUrl: (process.env.GRAPH_URL || "").replace(/\/$/, ""),

  // Durable job queue (BullMQ/Redis) that `POST /api/memories` enqueues to
  // instead of running LLM extraction + embedding inline — see the
  // `memoryStoreQueue`/`memoryStoreWorker` setup below.
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
};

// Service-to-service authentication is opt-in for backwards-compatible local
// development, but becomes mandatory as soon as a token is configured. Cloud
// deployments additionally set MEM0_LICENSE_CHECK_URL; memory operations then
// require an account identity and an active license response from the account
// service before they are allowed to proceed.
const mem0ApiToken = (process.env.MEM0_API_TOKEN || "").trim();
const licenseCheckUrl = (process.env.MEM0_LICENSE_CHECK_URL || "").trim().replace(/\/$/, "");
const licenseCheckToken = (process.env.MEM0_LICENSE_CHECK_TOKEN || "").trim();
const licenseCache = new Map<string, number>();
const LICENSE_CACHE_MS = 30_000;

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function accountIdFromRequest(c: any): string {
  return (c.req.header("X-AuraPunk-Account-Id") || "").trim();
}

function scopedMemoryUserId(c: any, userId: string): string {
  const accountId = accountIdFromRequest(c);
  return licenseCheckUrl && accountId ? `${accountId}:${userId}` : userId;
}

async function hasActiveLicense(accountId: string): Promise<boolean> {
  if (!licenseCheckUrl) return true;
  if (!accountId || !licenseCheckToken) return false;
  const cachedUntil = licenseCache.get(accountId);
  if (cachedUntil && cachedUntil > Date.now()) return true;

  try {
    const response = await fetch(licenseCheckUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${licenseCheckToken}`,
      },
      body: JSON.stringify({ account_id: accountId }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({} as any));
    const active = body?.active === true || body?.licensed === true;
    if (active) licenseCache.set(accountId, Date.now() + LICENSE_CACHE_MS);
    return active;
  } catch (error) {
    console.error(`[auth] license check failed: ${(error as Error).message}`);
    return false;
  }
}

const MEMORY_OPERATION_PREFIXES = [
  "/api/memories",
  "/api/search",
  "/api/graph/",
  "/api/re-extract/",
];

function isMemoryOperation(pathname: string): boolean {
  return MEMORY_OPERATION_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// ── Runtime configuration (persisted, overrides env) ────────────────────────
// The Settings → Memory panel in vibe-kanban writes these overrides so the
// extraction provider, models, keys, and graph toggle can be changed WITHOUT a
// container restart. Persisted to /data/config.json (mounted volume), merged
// over the env defaults, and re-loaded on startup.
const RUNTIME_CONFIG_PATH = process.env.MEM0_CONFIG_PATH || "/data/config.json";

interface ProviderCfg {
  url: string;
  key: string;
  model: string;
}

interface RuntimeConfigShape {
  provider: string;
  graph_enabled: boolean;
  providers: Record<string, Partial<ProviderCfg>>;
}

function providerFromEnv(p: LLMProvider): ProviderCfg {
  const c = config.llm[p];
  return { url: c.url, key: c.key, model: c.model };
}

function envRuntimeConfig(): RuntimeConfigShape {
  return {
    provider: config.llm.provider,
    graph_enabled: Boolean(config.graphUrl),
    providers: {
      groq: providerFromEnv("groq"),
      openrouter: providerFromEnv("openrouter"),
      llama: providerFromEnv("llama"),
      openai: providerFromEnv("openai"),
    },
  };
}

let runtimeConfig: RuntimeConfigShape = envRuntimeConfig();

function loadRuntimeConfig(): void {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
      runtimeConfig = {
        provider: raw.provider || config.llm.provider,
        graph_enabled:
          typeof raw.graph_enabled === "boolean"
            ? raw.graph_enabled
            : Boolean(config.graphUrl),
        providers: {
          groq: { ...providerFromEnv("groq"), ...(raw.providers?.groq ?? {}) },
          openrouter: { ...providerFromEnv("openrouter"), ...(raw.providers?.openrouter ?? {}) },
          llama: { ...providerFromEnv("llama"), ...(raw.providers?.llama ?? {}) },
          openai: { ...providerFromEnv("openai"), ...(raw.providers?.openai ?? {}) },
        },
      };
    }
  } catch (e) {
    console.warn(`[config] failed to load runtime config: ${(e as Error).message}`);
  }
}

function persistRuntimeConfig(): void {
  try {
    fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2));
  } catch (e) {
    console.error(`[config] failed to persist runtime config: ${(e as Error).message}`);
  }
}

loadRuntimeConfig();

function activeLlm(): { url: string; key: string; model: string } {
  const p = runtimeConfig.provider as LLMProvider;
  const pick = runtimeConfig.providers[p] ?? providerFromEnv(p);
  return {
    url: (pick.url || providerFromEnv(p).url).replace(/\/$/, ""),
    key: pick.key ?? "",
    model: pick.model ?? "",
  };
}

/**
 * Ordered extraction-LLM candidates. The configured primary comes first; any
 * other provider that has a URL + model + key is appended as a failover. If
 * the primary is rate-limited (free tiers, 429s) or errors, extraction falls
 * through to the next configured provider instead of hammering the same one.
 */
function llmCandidates(): { provider: string; url: string; key: string; model: string }[] {
  const order: LLMProvider[] = ["groq", "openrouter", "llama", "openai"];
  const primary = runtimeConfig.provider as LLMProvider;
  const ordered = [primary, ...order.filter((p) => p !== primary)];
  const out: { provider: string; url: string; key: string; model: string }[] = [];
  for (const p of ordered) {
    const c = runtimeConfig.providers[p] ?? providerFromEnv(p);
    const url = (c.url || providerFromEnv(p).url || "").replace(/\/$/, "");
    const model = c.model ?? "";
    const key = c.key ?? "";
    if (!url || !model) continue;
    // Cloud providers without a key can't authenticate; llama is keyless.
    if (p !== "llama" && !key) continue;
    out.push({ provider: p, url, key, model });
  }
  return out;
}

function graphEnabled(): boolean {
  return runtimeConfig.graph_enabled && Boolean(config.graphUrl);
}

// ── UUID (no external dep — Node 20 has crypto.randomUUID) ───────────────────
import { randomUUID } from "node:crypto";

// ── Qdrant client ─────────────────────────────────────────────────────────────

async function qdrantRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const url = `${config.qdrantUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Qdrant ${method} ${path} → ${resp.status}: ${text.slice(0, 400)}`);
  }
  return resp.json();
}

let collectionReady = false;

async function ensureCollection(): Promise<void> {
  if (collectionReady) return;
  try {
    await qdrantRequest("GET", `/collections/${config.collection}`);
  } catch {
    await qdrantRequest("PUT", `/collections/${config.collection}`, {
      vectors: { size: config.embedDim, distance: "Cosine" },
    });
  }
  collectionReady = true;
}

async function upsertPoint(
  id: string,
  content: string,
  userId: string,
  embedding: number[],
  extra?: Record<string, unknown>
): Promise<void> {
  await qdrantRequest("PUT", `/collections/${config.collection}/points`, {
    points: [
      {
        id,
        vector: embedding,
        payload: {
          content,
          user_id: userId,
          created_at: new Date().toISOString(),
          ...extra,
        },
      },
    ],
  });
}

async function searchPoints(
  userId: string,
  embedding: number[],
  limit: number
): Promise<any[]> {
  const result = await qdrantRequest(
    "POST",
    `/collections/${config.collection}/points/search`,
    {
      vector: embedding,
      limit,
      filter: { must: [{ key: "user_id", match: { value: userId } }] },
      with_payload: true,
    }
  );
  return result.result || [];
}

async function getAllPoints(userId: string): Promise<any[]> {
  let offset: string | null = null;
  const all: any[] = [];
  do {
    const body: Record<string, unknown> = {
      with_payload: true,
      with_vector: false,
      limit: 100,
    };
    if (userId) body.filter = { must: [{ key: "user_id", match: { value: userId } }] };
    if (offset) body.offset = offset;
    const result = await qdrantRequest(
      "POST",
      `/collections/${config.collection}/points/scroll`,
      body
    );
    all.push(...(result.result?.points || []));
    offset = result.result?.next_offset || null;
  } while (offset);
  return all;
}

async function getPoint(id: string): Promise<any> {
  // Use scroll + in-memory filter instead of POST /points/get,
  // which is unreliable on Qdrant ≥ 1.14 (returns 404 for valid UUIDs).
  const points = await getAllPoints("");
  return points.find((p: any) => p.id === id);
}

async function deletePoint(id: string): Promise<void> {
  await qdrantRequest(
    "POST",
    `/collections/${config.collection}/points/delete`,
    { points: [id] }
  );
}

// Delete a point and report whether it actually existed (delete is a no-op
// that still returns 200 for unknown ids, so the response alone can't tell).
async function deletePointVerified(id: string): Promise<number> {
  const existed = (await getPoint(id)) ? 1 : 0;
  await deletePoint(id);
  return existed;
}

async function deleteAllPoints(userId: string): Promise<void> {
  await qdrantRequest(
    "POST",
    `/collections/${config.collection}/points/delete`,
    { filter: { must: [{ key: "user_id", match: { value: userId } }] } }
  );
}

// ── Embedding resolver (local → llama → openai → openrouter) ────────────────

interface EmbedBackend {
  name: string;
  url: string;
  key: string;
  model: string;
}

function embeddingBackends(): EmbedBackend[] {
  const e = config.embed;
  return [
    { name: "local", url: e.local.url, key: e.local.key, model: e.local.model },
    { name: "llama", url: e.llama.url, key: e.llama.key, model: e.llama.model },
    { name: "openai", url: e.openai.url, key: e.openai.key, model: e.openai.model },
    { name: "openrouter", url: e.openrouter.url, key: e.openrouter.key, model: e.openrouter.model },
  ].filter((b) => b.url && b.model);
}

let lastEmbedBackend: string | null = null;

async function getEmbedding(text: string): Promise<number[]> {
  const backends = embeddingBackends();
  if (backends.length === 0) {
    throw new Error(
      "No embedding backend configured. Set EMBED_LOCAL_URL or EMBED_LLAMA_URL or OPENAI_API_KEY or EMBED_OPENROUTER_KEY."
    );
  }
  const errors: string[] = [];
  for (const b of backends) {
    try {
      const resp = await fetch(`${b.url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(b.key ? { Authorization: `Bearer ${b.key}` } : {}),
        },
        body: JSON.stringify({ model: b.model, input: [text] }),
      });
      if (!resp.ok) {
        errors.push(`${b.name}: HTTP ${resp.status}`);
        continue;
      }
      const data: any = await resp.json();
      const vec: number[] | undefined = data?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        errors.push(`${b.name}: bad payload`);
        continue;
      }
      if (vec.length !== config.embedDim) {
        errors.push(`${b.name}: dim ${vec.length} ≠ expected ${config.embedDim}`);
        continue;
      }
      lastEmbedBackend = b.name;
      return vec;
    } catch (err: any) {
      errors.push(`${b.name}: ${err?.message || err}`);
    }
  }
  throw new Error(`All embedding backends failed: ${errors.join(" | ")}`);
}

// ── LLM fact extraction ─────────────────────────────────────────────────────

const EXTRACT_SYSTEM = `Extract key facts from the user message.
Return a JSON object with EXACTLY this shape:
{
  "facts": ["short factual statement 1", "short factual statement 2"],
  "entities": [{"name": "EntityName", "type": "person|tech|project|concept|org|other", "description": "one-line"}],
  "relations": [{"subject": "A", "predicate": "uses|depends_on|is_part_of|created_by|conflicts_with|extends", "object": "B"}]
}
Rules:
- 2-6 facts max; 0-6 entities; 0-8 relations.
- Facts must be self-contained and re-stateable without context.
- Entities: proper nouns, tech names, project names, people, orgs.
- Relations: only if clearly stated or strongly implied.
- Output ONLY the JSON object. No code fences. No commentary. No reasoning blocks. No <think> tags.`;

async function llmChat(
  system: string,
  user: string,
  maxTokens = 700,
  // Extra acceptability check beyond "did I get parseable JSON at all" — e.g.
  // extractStructure passes one that also requires a non-empty graph when
  // graph mode is on. A candidate whose response fails this is treated the
  // same as a non-JSON response: failed over to the next candidate, not
  // returned. Without this, a provider that returns syntactically valid but
  // schema-empty JSON (e.g. `{"facts":[...],"entities":[],"relations":[]}`)
  // was silently accepted as "success" — observed in practice with groq's
  // qwen3.6-27b, which does this often enough to be a real reliability gap;
  // see docs/ADR/ADR-030-mem0-context-drift-measurement.md.
  isAcceptable?: (content: string) => boolean
): Promise<string> {
  const candidates = llmCandidates();
  if (candidates.length === 0) return "";

  const headersBase: Record<string, string> = {
    "Content-Type": "application/json",
    // OpenRouter appreciates attribution headers; harmless for other providers.
    "HTTP-Referer": "https://github.com/flashlan/vibe-kanban-alternative",
    "X-Title": "vibe-kanban-alternative",
  };

  for (const cand of candidates) {
    const headers = { ...headersBase };
    if (cand.key) headers.Authorization = `Bearer ${cand.key}`;

    // Retry on 429 (rate limit) with backoff; after the retries are exhausted,
    // fall through to the next configured provider instead of spamming one.
    let exhausted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(`${cand.url}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: cand.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.1,
            max_tokens: maxTokens,
          }),
        });
      } catch (err) {
        console.warn(`[llm] ${cand.provider} network error, trying next: ${(err as Error).message}`);
        exhausted = true;
        break;
      }
      if (resp.status === 429 && attempt < 2) {
        let wait = 5 + attempt * 6;
        const t = await resp.text().catch(() => "");
        const m = t.match(/in (\d+(?:\.\d+)?)s/i) || t.match(/"retry_after":\s*(\d+)/);
        if (m) wait = Math.max(wait, Math.ceil(parseFloat(m[1])));
        console.warn(`[llm] ${cand.provider} 429 rate limit, retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (resp.status === 429) {
        console.warn(`[llm] ${cand.provider} still rate-limited, failing over to next provider`);
        exhausted = true;
        break;
      }
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        console.warn(`[llm] ${cand.provider} HTTP ${resp.status}, failing over: ${t.slice(0, 200)}`);
        exhausted = true;
        break;
      }
      const data: any = await resp.json();
      const content: string = data?.choices?.[0]?.message?.content || "";
      // A provider that answers 200 but without a parseable JSON object is
      // useless for extraction (weak model, truncated output). Fail over to
      // the next candidate rather than returning garbage.
      if (parseLastJsonObject(content) === null) {
        console.warn(
          `[llm] ${cand.provider} returned no JSON object, failing over to next provider`
        );
        exhausted = true;
        break;
      }
      if (isAcceptable && !isAcceptable(content)) {
        console.warn(
          `[llm] ${cand.provider} returned JSON but failed the acceptability check (e.g. empty graph), failing over to next provider`
        );
        exhausted = true;
        break;
      }
      recordTokens(cand.provider, cand.model, data?.usage);
      return content;
    }
    if (!exhausted) {
      // All 3 attempts returned non-429, non-ok? Treat as failed over.
    }
  }
  throw new Error("all extraction LLM providers failed or are rate-limited");
}

interface Extracted {
  facts: string[];
  entities: { name: string; type: string; description: string }[];
  relations: { subject: string; predicate: string; object: string }[];
}

// ── Token usage ledger (extraction LLM) ────────────────────────────────────
// In-memory per-day totals plus per-provider/model totals. Exposed via
// GET /api/usage/tokens so the vibe-kanban Usage dashboard can monitor how
// many tokens the extraction model consumes. Persisted to disk (mounted
// volume) so restarting the container doesn't lose history, mirroring the
// RUNTIME_CONFIG_PATH pattern above.
interface DayTokens {
  prompt: number;
  completion: number;
}
interface ProviderTokens {
  provider: string;
  model: string;
  prompt: number;
  completion: number;
}
const tokenByDay = new Map<string, DayTokens>();
const tokenByProvider = new Map<string, ProviderTokens>();
// Per-day × provider split for segmented stacked bars in the Usage dashboard.
const tokenByDayProvider = new Map<string, Map<string, ProviderTokens>>();

const USAGE_LEDGER_PATH = process.env.MEM0_USAGE_PATH || "/data/usage.json";

function loadUsageLedger(): void {
  try {
    if (!fs.existsSync(USAGE_LEDGER_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(USAGE_LEDGER_PATH, "utf8"));
    for (const [day, t] of Object.entries<DayTokens>(raw.days ?? {})) {
      tokenByDay.set(day, { prompt: Number(t.prompt) || 0, completion: Number(t.completion) || 0 });
    }
    for (const [key, p] of Object.entries<ProviderTokens>(raw.providers ?? {})) {
      tokenByProvider.set(key, {
        provider: p.provider,
        model: p.model,
        prompt: Number(p.prompt) || 0,
        completion: Number(p.completion) || 0,
      });
    }
    for (const [day, byProvider] of Object.entries<Record<string, ProviderTokens>>(
      raw.dayProviders ?? {}
    )) {
      const m = new Map<string, ProviderTokens>();
      for (const [key, p] of Object.entries(byProvider)) {
        m.set(key, {
          provider: p.provider,
          model: p.model,
          prompt: Number(p.prompt) || 0,
          completion: Number(p.completion) || 0,
        });
      }
      tokenByDayProvider.set(day, m);
    }
  } catch (e) {
    console.warn(`[usage] failed to load token ledger: ${(e as Error).message}`);
  }
}

function persistUsageLedger(): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_LEDGER_PATH), { recursive: true });
    const dayProviders: Record<string, Record<string, ProviderTokens>> = {};
    for (const [day, m] of tokenByDayProvider.entries()) {
      dayProviders[day] = Object.fromEntries(m.entries());
    }
    const out = {
      days: Object.fromEntries(tokenByDay.entries()),
      providers: Object.fromEntries(tokenByProvider.entries()),
      dayProviders,
    };
    fs.writeFileSync(USAGE_LEDGER_PATH, JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(`[usage] failed to persist token ledger: ${(e as Error).message}`);
  }
}

loadUsageLedger();

function recordTokens(provider: string, model: string, usage: any): void {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  if (prompt === 0 && completion === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = tokenByDay.get(day) ?? { prompt: 0, completion: 0 };
  d.prompt += prompt;
  d.completion += completion;
  tokenByDay.set(day, d);
  const key = `${provider}|${model}`;
  const p = tokenByProvider.get(key) ?? { provider, model, prompt: 0, completion: 0 };
  p.prompt += prompt;
  p.completion += completion;
  tokenByProvider.set(key, p);
  // Per-day × provider split.
  let byProvider = tokenByDayProvider.get(day);
  if (!byProvider) {
    byProvider = new Map<string, ProviderTokens>();
    tokenByDayProvider.set(day, byProvider);
  }
  const dp = byProvider.get(key) ?? { provider, model, prompt: 0, completion: 0 };
  dp.prompt += prompt;
  dp.completion += completion;
  byProvider.set(key, dp);
  persistUsageLedger();
}

function tokenUsageReport(): {
  days: {
    day: string;
    prompt: number;
    completion: number;
    total: number;
    providers: ProviderTokens[];
  }[];
  providers: ProviderTokens[];
  total: number;
} {
  const days = [...tokenByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, t]) => ({
      day,
      prompt: t.prompt,
      completion: t.completion,
      total: t.prompt + t.completion,
      providers: [...(tokenByDayProvider.get(day)?.values() ?? [])],
    }));
  const providers = [...tokenByProvider.values()];
  const total = days.reduce((n, d) => n + d.total, 0);
  return { days, providers, total };
}

/**
 * Find the JSON object in an LLM response. Thinking-capable models (qwen3,
 * gpt-oss) prepend long, sometimes-unclosed `<think>` blocks that contain
 * their own `{...}` fragments. The real object is the LAST one, so we scan
 * `{` positions from the end backwards and return the first slice that
 * parses. No stripping — an unclosed `<think>` block must not swallow the
 * real JSON at the end.
 */
function parseLastJsonObject(text: string): any | null {
  let pos = text.length;
  while (true) {
    pos = text.lastIndexOf("{", pos - 1);
    if (pos < 0) break;
    const end = text.lastIndexOf("}");
    if (end <= pos) continue;
    const candidate = text.slice(pos, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // not a valid object from here; keep scanning earlier `{`
    }
  }
  return null;
}

/** Same cleaning + last-JSON-object scan `extractStructure` does below, reused
 * so `llmChat`'s acceptability check sees content the same way the real
 * parse will. Returns true iff the response has at least one entity or
 * relation — used only when graph mode is on, to reject a candidate's
 * syntactically valid but graph-empty response and fail over to the next
 * one instead of silently accepting a facts-only extraction. */
function hasGraphContent(content: string): boolean {
  const cleaned = content
    .replace(/```json\n?/gi, "")
    .replace(/```/gi, "")
    .trim();
  const parsed = parseLastJsonObject(cleaned);
  if (!parsed) return false;
  return normalizeEntities(parsed.entities).length > 0 || normalizeRelations(parsed.relations).length > 0;
}

async function extractStructure(text: string): Promise<Extracted> {
  const fallback: Extracted = { facts: [text], entities: [], relations: [] };
  const llm = activeLlm();
  if (!llm.url || !llm.model) return fallback;
  try {
    const raw = await llmChat(
      EXTRACT_SYSTEM,
      text,
      1500,
      graphEnabled() ? hasGraphContent : undefined
    );
    if (!raw) return fallback;
    // Some models (qwen3, gpt-oss) emit `<think>…</think>` reasoning blocks
    // (occasionally unclosed) containing their own `{...}` fragments before
    // the real JSON. Strip the code fences, then scan for the first JSON
    // object that actually parses — trying the LAST `{` first, because the
    // real object sits at the end, after the thinking.
    const cleaned = raw
      .replace(/```json\n?/gi, "")
      .replace(/```/gi, "")
      .trim();
    const parsed = parseLastJsonObject(cleaned) ?? (() => {
      throw new Error("no JSON object found in LLM output");
    })();
    return {
      facts:
        Array.isArray(parsed.facts) && parsed.facts.length
          ? parsed.facts.filter((f: unknown) => typeof f === "string")
          : [text],
      // Tolerate entities as objects ({name,type,description}) OR plain
      // strings (some models emit strings) — normalize to the object form.
      entities: normalizeEntities(parsed.entities),
      relations: normalizeRelations(parsed.relations),
    };
  } catch (err) {
    console.error(
      `[extract] LLM failed, storing raw text: ${(err as Error).message}`
    );
    return fallback;
  }
}

function normalizeEntities(raw: unknown): { name: string; type: string; description: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; type: string; description: string }[] = [];
  for (const e of raw) {
    if (typeof e === "string" && e.trim()) {
      out.push({ name: e.trim(), type: "concept", description: "" });
    } else if (
      e &&
      typeof e === "object" &&
      typeof (e as any).name === "string" &&
      (e as any).name.trim()
    ) {
      out.push({
        name: (e as any).name.trim(),
        type: typeof (e as any).type === "string" ? (e as any).type : "concept",
        description:
          typeof (e as any).description === "string"
            ? (e as any).description
            : "",
      });
    }
  }
  return out;
}

function normalizeRelations(
  raw: unknown
): { subject: string; predicate: string; object: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { subject: string; predicate: string; object: string }[] = [];
  for (const r of raw) {
    if (
      r &&
      typeof r === "object" &&
      typeof (r as any).subject === "string" &&
      typeof (r as any).predicate === "string" &&
      typeof (r as any).object === "string"
    ) {
      out.push({
        subject: (r as any).subject.trim(),
        predicate: (r as any).predicate.trim(),
        object: (r as any).object.trim(),
      });
    } else if (
      Array.isArray(r) &&
      r.length === 3 &&
      r.every((x) => typeof x === "string")
    ) {
      out.push({
        subject: (r[0] as string).trim(),
        predicate: (r[1] as string).trim(),
        object: (r[2] as string).trim(),
      });
    }
  }
  return out;
}

// ── Graph proxy (optional) ────────────────────────────────────────────────────

async function graphProxy(method: string, path: string, body?: unknown): Promise<any> {
  if (!config.graphUrl || !graphEnabled()) return undefined;
  const resp = await fetch(`${config.graphUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Graph ${method} ${path} → ${resp.status}: ${t.slice(0, 300)}`);
  }
  return resp.json();
}

async function pushToGraph(
  userId: string,
  entities: Extracted["entities"],
  relations: Extracted["relations"],
  commitSha?: string
): Promise<void> {
  if (!config.graphUrl || (entities.length === 0 && relations.length === 0)) return;
  await graphProxy("POST", `/graph/upsert`, {
    user_id: userId,
    entities,
    relations,
    ...(commitSha ? { commit_sha: commitSha } : {}),
  });
}

async function queryGraphNeighbors(
  userId: string,
  queryText: string
): Promise<{ neighbors: any[]; relations: any[] } | undefined> {
  if (!config.graphUrl) return undefined;
  try {
    const [neighbors, relations] = await Promise.all([
      graphProxy("POST", "/graph/neighbors", { user_id: userId, query: queryText }).catch(
        () => undefined
      ),
      graphProxy("POST", "/graph/relations", { user_id: userId, query: queryText }).catch(
        () => undefined
      ),
    ]);
    if (!neighbors && !relations) return undefined;
    return {
      neighbors: neighbors?.neighbors || neighbors?.result || [],
      relations: relations?.relations || relations?.result || [],
    };
  } catch (err) {
    console.error(`[graph] query failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Real multi-hop BFS from a matched starting node — unlike
 * `queryGraphNeighbors` (substring match + one hop of successors only, no
 * depth/direction control). Proxies to the embeddings container's
 * `/graph/traverse` (see embeddings/app.py), which caps hops and node count
 * itself. Returns `undefined` when the graph isn't configured or the
 * request fails — same graceful-degradation contract as the rest of this
 * file's graph functions. */
async function graphTraverse(
  userId: string,
  start: string,
  hops: number,
  direction: "out" | "in" | "both"
): Promise<
  | {
      matched_start_nodes: string[];
      nodes: { id: string; type: string; description: string }[];
      edges: { subject: string; predicate: string; object: string }[];
      truncated: boolean;
    }
  | undefined
> {
  if (!config.graphUrl) return undefined;
  try {
    const res = await graphProxy("POST", "/graph/traverse", {
      user_id: userId,
      start,
      hops,
      direction,
    });
    if (!res) return undefined;
    return {
      matched_start_nodes: res.matched_start_nodes || [],
      nodes: res.nodes || [],
      edges: res.edges || [],
      truncated: Boolean(res.truncated),
    };
  } catch (err) {
    console.error(`[graph] traverse failed: ${(err as Error).message}`);
    return undefined;
  }
}

// ── Core memory operations (shared by MCP + REST) ────────────────────────────

/**
 * `commitSha`: the calling workspace's HEAD commit at the time this fact was
 * saved (best-effort — the caller resolves it, e.g. via the VK API; `memory
 * -vk` itself has no git access). Stored on both the vector point payload
 * and the graph node/edge, so a later staleness check can ask "is this
 * still the code as of the commit this fact was true for" instead of
 * assuming every fact is permanently valid. Optional and additive — nothing
 * downstream requires it; see docs/ADR/ADR-030-mem0-context-drift-measurement.md.
 */
async function memoryStore(
  content: string,
  userId: string,
  commitSha?: string
): Promise<{
  stored: string[];
  ids: string[];
  entities: number;
  relations: number;
  graph: boolean;
}> {
  const uid = userId || config.defaultUser;
  await ensureCollection();
  const { facts, entities, relations } = await extractStructure(content);

  const stored: string[] = [];
  const ids: string[] = [];
  for (const fact of facts) {
    const embedding = await getEmbedding(fact);
    const id = randomUUID();
    await upsertPoint(id, fact, uid, embedding, {
      entities: entities.map((e) => e.name),
      relations: relations.map((r) => `${r.subject} -[${r.predicate}]-> ${r.object}`),
      ...(commitSha ? { commit_sha: commitSha } : {}),
    });
    stored.push(fact);
    ids.push(id);
  }

  let pushed = false;
  try {
    await pushToGraph(uid, entities, relations, commitSha);
    pushed = Boolean(config.graphUrl);
  } catch (err) {
    console.error(`[graph] push failed: ${(err as Error).message}`);
  }

  return { stored, ids, entities: entities.length, relations: relations.length, graph: pushed };
}

/**
 * Store one already-structured fact without invoking an LLM or the graph
 * extractor. This is intentionally separate from `memoryStore`: callers must
 * supply a self-contained fact that is ready to be embedded and recalled.
 */
async function memoryIndex(
  content: string,
  userId: string,
  commitSha?: string,
): Promise<{ stored: string; id: string }> {
  const uid = userId || config.defaultUser;
  await ensureCollection();
  const embedding = await getEmbedding(content);
  const id = randomUUID();
  await upsertPoint(id, content, uid, embedding, {
    source: "direct_index",
    ...(commitSha ? { commit_sha: commitSha } : {}),
  });
  return { stored: content, id };
}

// ── Durable memory-store queue (BullMQ/Redis) ───────────────────────────────
// `POST /api/memories` used to run `memoryStore` inline — LLM extraction +
// embedding on the request/response path — which blocks the calling agent
// for the full round trip. Enqueue instead: the route handler below returns
// 202 with a job id immediately, and this worker does the actual work in the
// background. Durable (survives a mem0-vk restart mid-job — BullMQ persists
// queued/active jobs in Redis) rather than an in-process queue, since this is
// meant to run on a shared server serving multiple concurrent agents.
type MemoryStoreJobData = {
  content: string;
  userId: string;
  commitSha?: string;
};

const memoryQueueConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

const MEMORY_STORE_QUEUE_NAME = "memory-store";

const memoryStoreQueue = new Queue<MemoryStoreJobData>(MEMORY_STORE_QUEUE_NAME, {
  connection: memoryQueueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    // Keep a bounded trail for debugging without growing Redis forever.
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  },
});

const memoryStoreWorker = new Worker<MemoryStoreJobData>(
  MEMORY_STORE_QUEUE_NAME,
  async (job: Job<MemoryStoreJobData>) => {
    const { content, userId, commitSha } = job.data;
    return memoryStore(content, userId, commitSha);
  },
  { connection: memoryQueueConnection, concurrency: 4 }
);

memoryStoreWorker.on("failed", (job, err) => {
  console.error(
    `[memory-store] job ${job?.id} failed after ${job?.attemptsMade} attempt(s): ${err.message}`
  );
});

async function memorySearch(
  query: string,
  userId: string,
  limit: number
): Promise<{ vector: any[]; graph?: { neighbors: any[]; relations: any[] }; embedding_backend: string | null }> {
  const uid = userId || config.defaultUser;
  await ensureCollection();
  const embedding = await getEmbedding(query);
  const vector = await searchPoints(uid, embedding, limit);
  const graph = await queryGraphNeighbors(uid, query);
  const embedding_backend = lastEmbedBackend;
  return { vector, graph, embedding_backend };
}

async function memoryRecall(userId: string): Promise<any[]> {
  const uid = userId || config.defaultUser;
  await ensureCollection();
  return getAllPoints(uid);
}

/**
 * Re-run graph extraction for memories that were stored before an extraction
 * LLM was configured (their payload.entities is empty). Retroactively fills the
 * entity/relation payloads and pushes the accumulated graph in one shot.
 */
async function reExtractGraph(userId: string): Promise<{
  scanned: number;
  updated: number;
  entities: number;
  relations: number;
}> {
  const uid = userId || config.defaultUser;
  await ensureCollection();
  const points = await getAllPoints(uid);
  const allEntities: { name: string; type: string; description: string }[] = [];
  const allRelations: { subject: string; predicate: string; object: string }[] = [];
  let updated = 0;

  for (const point of points) {
    const payload = point.payload || {};
    const content: string = typeof payload.content === "string" ? payload.content : "";
    const hasEntities =
      Array.isArray(payload.entities) && payload.entities.length > 0;
    if (!content || hasEntities) continue;

    const { entities, relations } = await extractStructure(content);
    if (entities.length === 0 && relations.length === 0) continue;

    // Pace the loop: free-tier providers (Groq/OpenRouter) have low per-minute
    // token budgets, and each extraction is ~1-2k tokens.
    await new Promise((r) => setTimeout(r, 1200));

    // Patch the stored point's payload so recall/search expose the graph fields.
    try {
      await qdrantRequest(
        "POST",
        `/collections/${config.collection}/points/payload`,
        {
          payload: {
            entities: entities.map((e) => e.name),
            relations: relations.map(
              (r) => `${r.subject} -[${r.predicate}]-> ${r.object}`
            ),
          },
          points: [point.id],
        }
      );
      updated += 1;
    } catch (err) {
      console.error(`[re-extract] payload patch failed for ${point.id}: ${(err as Error).message}`);
    }
    allEntities.push(...entities);
    allRelations.push(...relations);
  }

  if (allEntities.length > 0 || allRelations.length > 0) {
    try {
      await pushToGraph(uid, allEntities, allRelations);
    } catch (err) {
      console.error(`[re-extract] graph push failed: ${(err as Error).message}`);
    }
  }

  return {
    scanned: points.length,
    updated,
    entities: allEntities.length,
    relations: allRelations.length,
  };
}

// Returns memories pre-formatted for prompt injection.
// Inject AFTER the stable prefix (system + history) to preserve KV cache.
function formatMemories(points: any[]): string {
  if (!points.length) return "";
  const lines = points
    .map((p: any) => `- ${p.payload?.content ?? ""}`)
    .filter(Boolean);
  if (!lines.length) return "";
  return `--- project memories (${points.length}) — inject after stable prefix to keep KV cache ---\n${lines.join("\n")}`;
}

async function memoryUpdate(id: string, content: string, userId?: string): Promise<{
  ok: boolean;
  updated_user?: string;
  error?: string;
}> {
  await ensureCollection();
  const point: any = await getPoint(id);
  if (!point) return { ok: false, error: `memory ${id} not found` };
  const uid = userId || point.payload?.user_id || config.defaultUser;
  const { facts, entities, relations } = await extractStructure(content);
  const now = new Date().toISOString();
  const extra: Record<string, unknown> = {
    updated_at: now,
    entities: entities.map((e) => e.name),
    relations: relations.map((r) => `${r.subject} -[${r.predicate}]-> ${r.object}`),
  };
  // Replace the whole set of this user's facts with the freshly-extracted ones.
  // The original point keeps its id + created_at; the rest are removed first so
  // the point count reflects the new content (no stale sibling facts linger).
  const existing = await getAllPoints(uid);
  const otherIds = existing.map((p: any) => p.id).filter((pid) => pid !== id);
  for (const pid of otherIds) await deletePoint(pid);
  const factsToWrite = facts.length ? facts : [content.trim()].filter(Boolean);
  for (let i = 0; i < factsToWrite.length; i++) {
    const emb = await getEmbedding(factsToWrite[i]);
    if (i === 0) {
      await upsertPoint(id, factsToWrite[0], uid, emb, { ...extra, created_at: point.payload?.created_at });
    } else {
      await upsertPoint(randomUUID(), factsToWrite[i], uid, emb, extra);
    }
  }
  try {
    await pushToGraph(uid, entities, relations);
  } catch (err) {
    console.error(`[graph] push failed: ${(err as Error).message}`);
  }
  return { ok: true, updated_user: uid };
}

async function memoryForget(
  id?: string,
  userId?: string
): Promise<{ deleted: number; scope: "point" | "user" | "none" }> {
  await ensureCollection();
  if (id) {
    const deleted = await deletePointVerified(id);
    if (deleted && config.graphUrl) {
      await graphProxy("POST", "/graph/remove_node", { node_id: id }).catch(() => {});
    }
    return { deleted, scope: "point" };
  }
  if (userId) {
    await deleteAllPoints(userId);
    if (config.graphUrl) {
      await graphProxy("POST", "/graph/remove_user", { user_id: userId }).catch(() => {});
    }
    return { deleted: 1, scope: "user" };
  }
  return { deleted: 0, scope: "none" };
}

// ── MCP server (stateless Streamable-HTTP transport) ─────────────────────────

const MCP_INFO = { name: "mem0-vk", version: "1.0.0" };

// Tool definitions are shared across connections; each /mcp request gets a
// fresh McpServer (one connect() per transport — a reused instance throws
// "Already connected to a transport" on the second request).
type ToolDef = {
  name: string;
  description: string;
  schema: any;
  handler: (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;
};
const mcpToolDefs: ToolDef[] = [];
function mcpTool(name: string, description: string, schema: any, handler: ToolDef["handler"]) {
  mcpToolDefs.push({ name, description, schema, handler });
}
function createMcpServer(): McpServer {
  const server = new McpServer(MCP_INFO);
  for (const t of mcpToolDefs) {
    (server as any).registerTool(t.name, {
      description: t.description,
      inputSchema: t.schema,
    }, t.handler);
  }
  return server;
}

mcpTool(
  "memory_store",
  "Queue a new memory for storage. The LLM extraction, embedding, and (if configured) graph push run in the background — this returns immediately with a job id, not the extracted facts.",
  {
    content: z.string().describe("The content to remember"),
    user_id: z.string().optional().describe("Project/user ID for isolation (repo slug)"),
  },
  async ({ content, user_id }) => {
    const job = await memoryStoreQueue.add("store", {
      content,
      userId: user_id || "",
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Queued for "${user_id || config.defaultUser}" (job ${job.id}) — extraction and storage happen in the background.`,
        },
      ],
    };
  }
);

mcpTool(
  "memory_search",
  "Semantic search over stored memories (Qdrant vectors + optional graph neighbors).",
  {
    query: z.string().describe("Search query"),
    user_id: z.string().optional().describe("Project/user ID filter"),
    limit: z.number().optional().describe("Max vector results (default 5)"),
  },
  async ({ query, user_id, limit }) => {
    const res = await memorySearch(query, user_id || "", limit || 5);
    const lines: string[] = [];
    if (res.vector.length) {
      lines.push("Vector hits:");
      res.vector.forEach((r: any, i: number) =>
        lines.push(`  ${i + 1}. [${r.id}] (${r.score.toFixed(3)}) ${r.payload?.content}`)
      );
    } else {
      lines.push("No vector hits.");
    }
    if (res.graph) {
      if (res.graph.relations.length) {
        lines.push("Graph relations:");
        res.graph.relations.forEach((r: any) =>
          lines.push(`  ${r.subject} -[${r.predicate}]-> ${r.object}`)
        );
      }
      if (res.graph.neighbors.length) {
        lines.push("Graph neighbors:");
        res.graph.neighbors.forEach((n: any) =>
          lines.push(`  ${n.name || n.id} (${n.type || "?"}) ${n.description || ""}`)
        );
      }
    }
    lines.push(`(embedding backend: ${res.embedding_backend || "n/a"})`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

mcpTool(
  "memory_recall",
  "Recall all stored memories for a project (paginated scroll).",
  {
    user_id: z.string().describe("Project/user ID"),
  },
  async ({ user_id }) => {
    const all = await memoryRecall(user_id);
    if (all.length === 0) {
      return {
        content: [
          { type: "text" as const, text: `No memories stored for "${user_id}"` },
        ],
      };
    }
    const text = formatMemories(all);
    return {
      content: [
        {
          type: "text" as const,
          text: text,
        },
      ],
    };
  }
);

mcpTool(
  "memory_update",
  "Update an existing memory with new content (re-extracts facts; updates entities/relations).",
  {
    memory_id: z.string().describe("Memory ID (UUID) to update"),
    content: z.string().describe("New content"),
    user_id: z.string().optional().describe("Project/user ID (defaults to existing point's)"),
  },
  async ({ memory_id, content, user_id }) => {
    const res = await memoryUpdate(memory_id, content, user_id);
    if (!res.ok) {
      return {
        content: [{ type: "text" as const, text: `Memory ${memory_id}: ${res.error}` }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Memory ${memory_id} updated (user: ${res.updated_user})`,
        },
      ],
    };
  }
);

mcpTool(
  "memory_forget",
  "Delete a specific memory by ID, or all memories for a user/project.",
  {
    memory_id: z.string().optional().describe("Specific memory UUID to delete"),
    user_id: z.string().optional().describe("Delete all memories for this project"),
  },
  async ({ memory_id, user_id }) => {
    const res = await memoryForget(memory_id, user_id);
    if (res.scope === "point")
      return {
        content: [{ type: "text" as const, text: `Memory ${memory_id} deleted` }],
      };
    if (res.scope === "user")
      return {
        content: [
          { type: "text" as const, text: `All memories for "${user_id}" deleted` },
        ],
      };
    return {
      content: [{ type: "text" as const, text: "Provide memory_id or user_id" }],
    };
  }
);

// ── Hono app: MCP + REST ────────────────────────────────────────────────────

const app = new Hono();

// All non-health traffic uses the same Bearer contract for the split Docker
// stack, local embedded deployments, and the hosted Mem0 service. The token
// remains optional when no token is configured so existing development tests
// and deliberately open local installs keep working. Hosted deployments must
// set both MEM0_API_TOKEN and the license-check variables.
app.use("*", async (c, next) => {
  const pathname = c.req.path;
  if (pathname !== "/health" && mem0ApiToken) {
    const authorization = c.req.header("Authorization") || "";
    if (!safeTokenEqual(authorization, `Bearer ${mem0ApiToken}`)) {
      return c.json({ error: "Missing or invalid Mem0 bearer token" }, 401);
    }
  }

  if (pathname !== "/health" && licenseCheckUrl && isMemoryOperation(pathname)) {
    const accountId = accountIdFromRequest(c);
    if (!accountId) {
      return c.json({ error: "Account identity is required for server memory" }, 401);
    }
    if (!(await hasActiveLicense(accountId))) {
      return c.json({ error: "An active AuraPunk license is required for server memory" }, 403);
    }
  }

  return next();
});

app.get("/", (c) => c.json({
  name: "mem0-vk",
  version: "1.0.0",
  endpoints: {
    mcp: "/mcp",
    rest: {
      store: "POST /api/memories",
      index: "POST /api/memories/index (vector-only; no LLM extraction)",
      search: "POST /api/search",
      recall: "GET /api/memories/:user_id",
      update: "PATCH /api/memories/:id",
      forget: "DELETE /api/memories/:id",
      forgetAll: "DELETE /api/memories/:user_id",
      health: "GET /health",
    },
    embedding_backend: lastEmbedBackend,
    llm_provider: config.llm.provider,
    graph: config.graphUrl || "disabled",
  },
}));

app.get("/health", (c) =>
  c.json({ ok: true, ts: new Date().toISOString(), collection: config.collection, dim: config.embedDim })
);

// MCP Streamable-HTTP — stateless: fresh transport AND fresh McpServer per
// request (an McpServer can only be connected to one transport).
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await createMcpServer().connect(transport);
  return transport.handleRequest(c.req.raw);
});

// ── REST routes ─────────────────────────────────────────────────────────────

app.post("/api/memories", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const content: string = body?.content;
  const user_id: string = scopedMemoryUserId(c, body?.user_id || "");
  const commit_sha: string | undefined =
    typeof body?.commit_sha === "string" && body.commit_sha ? body.commit_sha : undefined;
  if (!content || typeof content !== "string") {
    return c.json({ error: "missing string field 'content'" }, 400);
  }
  const job = await memoryStoreQueue.add("store", {
    content,
    userId: user_id || "",
    commitSha: commit_sha,
  });
  return c.json({ ok: true, queued: true, job_id: job.id }, 202);
});

// Direct vector indexing for callers that already have a self-contained fact.
// Unlike POST /api/memories, this does not queue or invoke LLM extraction and
// it never writes to the graph.
app.post("/api/memories/index", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const content: string = body?.content;
  const user_id: string = scopedMemoryUserId(c, body?.user_id || "");
  const commit_sha: string | undefined =
    typeof body?.commit_sha === "string" && body.commit_sha ? body.commit_sha : undefined;
  if (!content || typeof content !== "string") {
    return c.json({ error: "missing string field 'content'" }, 400);
  }
  const indexed = await memoryIndex(content, user_id, commit_sha);
  return c.json({ ok: true, vector_only: true, ...indexed }, 201);
});

// Best-effort status lookup for a queued save — mainly for debugging/tests;
// callers of POST /api/memories are not expected to poll this.
app.get("/api/memories/jobs/:jobId", async (c) => {
  const job = await memoryStoreQueue.getJob(c.req.param("jobId"));
  if (!job) return c.json({ error: "job not found" }, 404);
  const state = await job.getState();
  return c.json({
    id: job.id,
    state,
    result: state === "completed" ? job.returnvalue : undefined,
    failedReason: state === "failed" ? job.failedReason : undefined,
  });
});

app.post("/api/search", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const query: string = body?.query;
  const user_id: string = scopedMemoryUserId(c, body?.user_id || "");
  const limit: number | undefined = body?.limit;
  if (!query || typeof query !== "string") {
    return c.json({ error: "missing string field 'query'" }, 400);
  }
  const res = await memorySearch(query, user_id || "", limit || 5);
  return c.json(res);
});

app.post("/api/graph/traverse", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const start: string = body?.start;
  const user_id: string = scopedMemoryUserId(c, body?.user_id || "");
  const hops: number | undefined = body?.hops;
  const direction: "out" | "in" | "both" | undefined = body?.direction;
  if (!start || typeof start !== "string") {
    return c.json({ error: "missing string field 'start'" }, 400);
  }
  const res = await graphTraverse(user_id || "", start, hops ?? 2, direction ?? "both");
  if (!res) return c.json({ error: "graph not configured or traverse failed" }, 503);
  return c.json({ ok: true, ...res });
});

app.post("/api/re-extract/:user_id", async (c) => {
  const user_id = scopedMemoryUserId(c, c.req.param("user_id") || "");
  const res = await reExtractGraph(user_id);
  return c.json({ ok: true, ...res });
});

app.get("/api/usage/tokens", async (c) => {
  return c.json({ ok: true, ...tokenUsageReport() });
});

app.get("/api/config", async (c) => {
  // Sanitized view: never leak full keys — only whether one is set.
  const providers: Record<string, any> = {};
  for (const p of ["groq", "openrouter", "llama", "openai"] as LLMProvider[]) {
    const pc = runtimeConfig.providers[p] ?? providerFromEnv(p);
    providers[p] = {
      url: pc.url || "",
      model: pc.model || "",
      has_key: Boolean(pc.key),
    };
  }
  return c.json({
    ok: true,
    provider: runtimeConfig.provider,
    graph_enabled: runtimeConfig.graph_enabled,
    graph_url: config.graphUrl || "",
    providers,
    collection: config.collection,
  });
});

app.post("/api/config", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.provider === "string") {
    const p = body.provider as LLMProvider;
    if (runtimeConfig.providers[p]) runtimeConfig.provider = p;
  }
  if (typeof body?.graph_enabled === "boolean") {
    runtimeConfig.graph_enabled = body.graph_enabled;
  }
  if (body?.providers && typeof body.providers === "object") {
    for (const p of ["groq", "openrouter", "llama", "openai"] as LLMProvider[]) {
      const patch = body.providers[p];
      if (!patch || typeof patch !== "object") continue;
      const cur = runtimeConfig.providers[p] ?? providerFromEnv(p);
      if (typeof patch.url === "string" && patch.url !== "") cur.url = patch.url;
      if (typeof patch.model === "string" && patch.model !== "") cur.model = patch.model;
      if (typeof patch.key === "string" && patch.key !== "") cur.key = patch.key;
      // Empty string clears the key.
      if (typeof patch.key === "string" && patch.key === "") cur.key = "";
      runtimeConfig.providers[p] = cur;
    }
  }
  persistRuntimeConfig();
  return c.json({ ok: true, ...(await (async () => {
    const providers: Record<string, any> = {};
    for (const p of ["groq", "openrouter", "llama", "openai"] as LLMProvider[]) {
      const pc = runtimeConfig.providers[p] ?? providerFromEnv(p);
      providers[p] = { url: pc.url || "", model: pc.model || "", has_key: Boolean(pc.key) };
    }
    return { provider: runtimeConfig.provider, graph_enabled: runtimeConfig.graph_enabled, providers };
  })()) });
});

app.get("/api/memories/:user_id", async (c) => {
  const user_id = scopedMemoryUserId(c, c.req.param("user_id"));
  const all = await memoryRecall(user_id);
  // prompt_block: ready-to-inject text — put it AFTER system+history in the prompt.
  return c.json({ user_id, count: all.length, prompt_block: formatMemories(all), memories: all });
});

app.patch("/api/memories/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const content: string = body?.content;
  const user_id: string | undefined = typeof body?.user_id === "string"
    ? scopedMemoryUserId(c, body.user_id)
    : undefined;
  if (!content || typeof content !== "string") {
    return c.json({ error: "missing string field 'content'" }, 400);
  }
  const res = await memoryUpdate(id, content, user_id);
  if (!res.ok) return c.json({ ok: false, error: res.error }, 404);
  return c.json(res);
});

// Single DELETE route: a UUID deletes one point; anything else is treated as
// user_id (delete-all). Hono matches `:id` before `:user_id`, so two routes
// with the same shape would make the delete-all path unreachable.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.delete("/api/memories/:id", async (c) => {
  const raw = c.req.param("id");
  if (UUID_RE.test(raw)) {
    const res = await memoryForget(raw);
    return c.json(res);
  }
  const res = await memoryForget(undefined, scopedMemoryUserId(c, raw));
  return c.json(res);
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  await ensureCollection();
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const addr = (info as any)?.address?.address || config.host;
    console.error(`mem0-vk listening on http://${addr}:${info.port}`);
    console.error(`  MCP:        http://${addr}:${info.port}/mcp`);
    console.error(`  REST:       http://${addr}:${info.port}/api/*`);
    console.error(`  LLM:        ${config.llm.provider} → ${activeLlm().model || "(unset)"}`);
    console.error(`  Graph:      ${config.graphUrl || "disabled"}`);
    console.error(`  Collection: ${config.collection} (dim=${config.embedDim})`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
