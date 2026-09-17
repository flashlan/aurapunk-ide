# ADR-045: Settings Add-ons tab with Graphify memory-graph renderer

- **Status**: Accepted
- **Date**: 2026-09-17

## Context

ADR-043 exposed a bounded mem0 semantic-graph projection
(`POST /api/usage/memory-graph`) and rendered it as a static SVG inside
Settings → Usage. That surface is read-only: no search, no zoom, no way to
inspect a node's relations. Separately, Graphify
(https://github.com/Graphify-Labs/graphify) is the reference UX for this
exact job — a codebase/memory knowledge graph you query and traverse instead
of grepping — with `graph.html` as its interactive map. The app had no
extension point for optional integrations of this kind.

## Decision

- Add a host-scoped `addons` section to the Settings registry
  (`settingsRegistry.tsx`), rendered after Memory/Backup with a
  `PuzzlePieceIcon` nav entry. Titles resolve through the existing
  `settings.layout.nav.*` i18n keys, so no dialog plumbing changes.
- Introduce an add-on registry local to `AddonsSettingsSection.tsx`: each
  entry declares an id, homepage, default-enabled flag, and a panel render
  function. Enable toggles persist per browser in localStorage
  (`aurapunk.settings.addons-enabled`); corrupt storage degrades to defaults.
  New add-ons only add an entry — no registry edits.
- Ship Graphify as the first add-on (enabled by default). Its panel is
  `MemoryGraphViewer.tsx`, an interactive renderer over the existing
  `/api/usage/memory-graph` projection (same nodes/edges shape as Graphify's
  `graph.json`): deterministic force layout (`memoryGraphLayout.ts`, pure and
  unit-tested), node search with match counts, wheel zoom + drag pan, node
  dragging, type legend with filtering, and click-to-inspect node details
  with traversable incoming/outgoing relations.
- No backend changes: the endpoint, proxy, and bounded projection from
  ADR-043 are reused as-is. No new npm dependencies.

## Consequences

- Users get a Graphify-style map of the mem0 graph without leaving Settings,
  including per-`user_id` (per-repository) selection consistent with the
  project's memory scoping.
- The static Usage-section canvas stays untouched; the interactive viewer is
  the add-on's panel, so disabling Graphify removes the whole surface.
- Future integrations (e.g. additional renderers or memory providers) follow
  the same one-entry pattern.
- Verification is limited to unit tests for the layout helpers plus manual
  review: `node_modules` is not installed in this workspace, so `tsc` and
  `vitest` could not run here — run `pnpm run check` and the web-core suite
  before merging.
