"""Laya ModernBERT System-1 decision server (local Docker mode).

Exposes the typed-question contract the AuraPunk compactor calls:

    POST /predict   {"state": <string|object>, "questions": {...}} -> {"answers": {...}}
    POST /evaluate  alias of /predict
    GET  /health    readiness + whether the model loaded

Build & run (see packages/jev-plugin/README.md):

    docker build -t laya-local packages/jev-plugin/docker
    docker run -d -p 8080:8080 laya-local
"""

from __future__ import annotations

import os
from typing import Any

import uvicorn
from fastapi import FastAPI, Request

app = FastAPI(title="Laya ModernBERT Decision Server")

MODEL_ID = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
agent: Any = None
load_error: str | None = None


@app.on_event("startup")
def load_model() -> None:
    global agent, load_error
    try:
        import laya

        print(f"[Laya Server] Loading weights from {MODEL_ID}...")
        agent = laya.load(MODEL_ID)
        print("[Laya Server] Model loaded successfully.")
    except Exception as error:  # noqa: BLE001 - surfaced via /health
        load_error = str(error)
        print(f"[Laya Server] Model load failed: {error}")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok" if agent is not None else "degraded",
        "model": MODEL_ID,
        "loaded": agent is not None,
        "error": load_error,
    }


def _normalize(answers: Any) -> dict[str, Any]:
    """Map the raw Laya output onto the DecisionAnswer contract the compactor
    reads (noul -> probability/verdict, score -> levelIndex/levelLabel)."""
    if not isinstance(answers, dict):
        return {}
    normalized: dict[str, Any] = {}
    for key, answer in answers.items():
        if not isinstance(answer, dict):
            normalized[key] = answer
            continue
        kind = answer.get("type")
        if kind == "noul":
            probability = answer.get("noul", answer.get("probability", 0.0))
            normalized[key] = {
                "type": "noul",
                "probability": probability,
                "verdict": probability >= 0.5,
            }
        elif kind == "choice":
            normalized[key] = {
                "type": "choice",
                "choice": answer.get("choice"),
                "confidence": answer.get("confidence", 0.0),
                "probabilities": answer.get("probabilities", {}),
            }
        elif kind == "score":
            criteria = answer.get("criteria") or []
            legend = answer.get("legend") or {}
            score = answer.get("score", 0.0)
            max_index = max(1, len(criteria) - 1)
            level_index = int(min(max_index, max(0, round(score))))
            label = (
                criteria[level_index]
                if criteria
                else legend.get(str(level_index), legend.get(level_index, ""))
            )
            normalized[key] = {
                "type": "score",
                "score": score,
                "levelIndex": level_index,
                "levelLabel": label,
                "confidence": answer.get("confidence", 0.0),
            }
        else:
            normalized[key] = answer
    return normalized


async def _run(request: Request) -> dict[str, Any]:
    payload = await request.json()
    state = payload.get("state", "")
    questions = payload.get("questions", {})

    if agent is None:
        # Fail loudly instead of returning fabricated probabilities, so the
        # caller can tell the endpoint is unavailable.
        return {
            "answers": {},
            "engine": "laya-unavailable",
            "error": load_error or "Laya model is not loaded",
        }

    result = agent.predict(state, questions)
    raw = result["answers"] if isinstance(result, dict) and "answers" in result else result
    return {"answers": _normalize(raw), "engine": "laya-hf"}


@app.post("/predict")
async def predict(request: Request) -> dict[str, Any]:
    return await _run(request)


@app.post("/evaluate")
async def evaluate(request: Request) -> dict[str, Any]:
    return await _run(request)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
