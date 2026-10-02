# ADR-052: Local Usage Ledger and API

- **Status:** Accepted
- **Date:** 2026-10-02

## Context

AuraPunk currently receives token observations from several agent normalizers,
shows live context in chat, persists `token_usage_records`, and also retains an
in-memory daily telemetry accumulator. These surfaces must not compete as
independent sources of truth. A team-oriented product also needs stable report
and export contracts without making a local installation depend on a cloud
service.

## Decision

`token_usage_records` is the durable raw ledger. A reconciled per-execution
projection derived from that ledger is the canonical source for all usage
totals. The projection must preserve measurement provenance and never silently
convert partial observations into billing claims.

The server exposes a versioned, local-first reporting API under
`/api/v1/usage`. The Settings UI, CSV exports and future benchmark features are
clients of this API; they must not query a separate in-memory accumulator.

The initial API contract is designed for future tenant sync but remains fully
local: project, card, workspace and execution IDs are stable external
identifiers; tenant/team/user scope is locally implicit. A future hosted
ingestion service may resolve those scopes from an authenticated API key, but
the desktop ledger never requires it to operate.

## Consequences

- Token observations are labelled as measured usage, not provider billing.
- Cumulative agent snapshots are reconciled per execution before aggregation;
  they are never summed event-by-event.
- The legacy in-memory token telemetry becomes a cache or is retired from
  reporting once the API projection is available.
- CSV contains the same filtered rows and totals returned by the API.
- Prompts, transcripts and secrets never belong in usage events or exports.
