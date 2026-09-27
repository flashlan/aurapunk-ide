# ADR-049: Team scopes and multi-writer board sync (ADR-047 phase 5)

## Status

Proposed — rollout step 1 (Cloud) implemented 2026-09-27

## Date

2026-09-27

## Context

ADR-047 phases 1–4 made the Cloud log reliable (atomic revisions, outbox
publisher, command queue, retention, signal-driven long-polls). All data is
still partitioned by `user_id`, and the Desktop only *publishes*: it never
applies board changes made elsewhere, except for the best-effort card-move
mirror in the webview. Two instances of the same account already overwrite
each other's board records with stale state, and a team (ADR-048 T1) cannot
exist on this model.

AuraPunk Cloud already has `tenants` (plan `personal` | `enterprise`) and
`memberships` (`owner` | `admin` | `member`); team creation is not open yet.

## Decision

### 1. Scope = tenant, shared per project

- Every sync row gets a `scope_id`: `user:<user_id>` for personal data
  (today's partition, backfilled) or `tenant:<tenant_id>` for a team.
- **Sharing is per project.** A project is either personal or shared with one
  team; its statuses, issues, tags, relations, comments and issue↔workspace
  links live in that project's scope. Execution records (workspaces,
  contexts, chat) stay in the owner's personal scope and are only visible to
  the team as summaries on the card (ADR-047: execution is single-writer).
- A device token authorizes the user's personal scope and every tenant scope
  the user is a member of. Requests name the scope explicitly
  (`X-AuraPunk-Scope`); omitted means personal, so current clients keep
  working unchanged.

### 2. Board writes carry a base revision

- Each upsert/delete of a board entity may carry `baseRevision` — the Cloud
  revision of that record the writer last saw. If the stored record has a
  higher revision, the operation is **rejected as a conflict** and returned
  with the current record instead of overwriting it.
- Writes without `baseRevision` keep last-writer-wins (single-writer
  execution records, legacy clients).
- Conflict resolution is per field on the client: fields the local writer did
  not change take the remote value; a field both changed takes the most
  recent human edit, and the loser is kept in the card's history.

### 3. The Desktop becomes bidirectional for shared projects

- A `cloud_sync_remote` table stores, per synced entity, the Cloud revision
  last applied or published (the base for the next write).
- A board puller long-polls each shared scope (`/api/sync?after_revision`),
  applies remote changes to SQLite **without re-enqueuing them in the outbox**
  (triggers skip rows written by the puller), and resolves conflicts reported
  by the publisher as above.
- The webview card-move mirror is removed.

### Rollout

1. **Cloud (done).** Migration 0014 added `scope_id` + backfill + dual-write
   and `baseRevision` conflicts; after the backfill was verified in
   production (0 rows missing or mismatched), 0015 made `scope_id` the
   partition (primary keys, cursors, command queue, retention, NOTIFY).
   `X-AuraPunk-Scope` selects the scope (personal by default, tenant scopes
   for members only). Verified in production: new keys, continuous revision,
   403 for a foreign tenant, command round trip.
2. Desktop: `cloud_sync_remote`, base revisions on publish, board puller for
   shared scopes, conflict merge; remove the webview mirror.
3. Product: open team creation (ADR-048 T1) and per-project "share with team".

## Consequences

- Personal use is unchanged: everything stays in `user:<id>` and clients that
  do not send a scope keep working.
- Two instances of one account stop overwriting each other once phase 2 of
  the rollout ships (they share the personal scope with base revisions).
- The primary-key switch is the one hard-to-reverse step; it runs only after
  the backfill is verified.
- Execution data never crosses into a team scope; a teammate sees the
  card's workspace status, not another member's transcripts.
