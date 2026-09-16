# ADR-043: Render bounded semantic memory and durable recall progress locally

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

Mem0 stores semantic records in Qdrant and, when graph extraction is enabled,
stores entities and directed relations in a per-repository NetworkX graph. The
IDE had traversal tools for agents, but no visual surface for a developer to
inspect the relationship structure. Recall relevance was also only available
as an in-memory daily aggregate, which resets on server restart and cannot
show changes while agents are running.

## Decision

- Expose a bounded graph projection from the graph sidecar. It returns only
  normalized entity identifiers, types, descriptions, degrees, and relation
  labels. It never returns Qdrant vectors, original memory text, prompts, or
  storage credentials.
- Proxy that projection through the local backend and render it in Settings →
  Usage as a deterministic force-directed SVG. The graph is capped to the most
  connected 160 nodes, so a large repository cannot make the settings screen
  unusable.
- Persist one minimal event for each `memory_search` relevance report:
  timestamp, optional top score, and `hit`/`weak` outcome. The content of the
  query and recalled memories is intentionally not stored.
- Combine the last 24 hours of persisted recall events with failed/killed
  execution-process completions into minute buckets. The UI renders this as a
  scatter/trend view named accurately: hits, weak recalls, and failures.

## Consequences

- The visual graph reflects extracted semantic relationships, while Qdrant
  remains the private vector backing store. A disabled/offline graph service
  produces an unavailable state rather than failing the Usage dashboard.
- Recall-quality history survives a server restart. Existing installations
  begin accumulating data after the migration; historical events are not
  invented or backfilled.
- A `weak recall` is a top score below `0.3` (or no scored result), not a
  proof that a model made an incorrect decision. The UI must not call it a
  model-loss metric.
