# ADR-047: Ownership-based Cloud sync (Desktop, Mobile, Cloud instances)

## Status

Proposed — phase 1 implemented (2026-09-26), phases 2, 3 and 4 implemented (2026-09-27)

## Date

2026-09-26

## Context

Three clients share one account through AuraPunk Cloud `/api/sync`
(private `aurapunk-cloud`, see ADR-040/042): the Desktop, the Android app
(ADR-041/042) and Cloud instances seeded by the compute agent. A code review
of the three sides found the sync slow and lossy:

- The Desktop publisher lives in the webview (`CloudAuthActions.tsx`) and, on
  every workspace-stream message, exports the whole local DB
  (`GET /api/mobile/context`, including every chat turn ever) and re-pushes it
  in batches of 100. No window → no sync; two windows → two publishers.
- The Cloud allocated revisions as `max(revision) + 1` outside a transaction
  (concurrent pushes reused revisions and readers skipped events), had no index
  on `sync_events (user_id, revision)`, long-polled that table every 250 ms,
  and its snapshot kept the *oldest* 5000 records — a new Cloud instance was
  seeded without the most recent cards.
- Only upserts were published, so deletions never propagated.
- Relayed commands (Mobile chat prompts, workspace requests) shared the event
  log with a cursor kept in `localStorage` and had no idempotency key: a lost
  cursor or a second window re-sent prompts to agents.
- In Cloud mode the Android app ignored every sync event (board refreshed only
  by a 30 s timer) and restarted its cursor at 0 on each launch. Its Cloud
  workspace request used `operation: "insert"`, which the Cloud rejects.
- With a Cloud instance running, two instances republish the full board and the
  last push wins even when stale.

The full-DB export originates in Cloud-instance bootstrap, which does need the
whole account — but only once.

## Decision

Sync by **data ownership**, with a one-time bootstrap followed by deltas.

| Data | Owner | Model |
|---|---|---|
| Board (projects, statuses, issues, tags, comments) | Cloud (shared; team later) | multi-writer, server revision |
| Execution (workspace, sessions, transcript) | instance that runs it | single writer, publish-only |
| Catalog (models, pipelines) | each instance | per-instance record with revision/hash |
| Commands (Mobile → Desktop, member → member) | Cloud queue | atomic claim, idempotent id |

Every client (Desktop, Android, Cloud instance) uses one protocol: paged
snapshot → returns revision R → stream deltas after R → re-snapshot on a gap.
A Cloud instance is simply another instance with its own `instance_id`; its
seed is the bootstrap snapshot. Moving a workspace between instances is an
ownership transfer via lease (ADR-042 compute), not a DB copy.

### Phases

1. **Log integrity (done).** Cloud: per-account `sync_cursors` allocator taken
   inside the push transaction (serializes commits per account), batched
   writes, indexes, cursor-row long-poll, paged snapshot by
   `(revision, entity_type, entity_id)`, legacy snapshot keeps the newest
   records, `after_revision=latest`. Desktop: `relayed_commands` claims make
   each relayed command run once (`command_id` = Cloud event id). Android:
   stream starts at `latest`, board events trigger a debounced refresh, Cloud
   workspace requests use `upsert` and a unique id.
2. **Desktop publisher in Rust (done).** Move publishing out of the webview into a
   backend `cloud_sync` service fed by the existing `HookTables`/`KanbanEvent`
   bus through a `sync_outbox` (idempotency key `(instance_id, local_seq)`),
   publishing changed rows and tombstones only; transcripts on turn
   completion. Remove the full export from the steady state.
   Implemented as SQLite triggers → `cloud_sync_outbox` (capture only while
   an account is linked, `cloud_sync_state.enabled`), the
   `routes::cloud_sync` publisher (coalesce per entity, payload from the
   current row, missing row → tombstone, chunks of 100, oversized/rejected
   records dropped instead of wedging the queue, backoff up to 5 min), a
   one-time bootstrap per linked account, the execution catalog every 15 min,
   and `PUT /api/cloud-sync/account` / `GET /api/cloud-sync/status`. The
   webview only hands over the account; commands are still polled there
   until phase 3.
3. **Command queue (done).** Dedicated Cloud table (`pending → claimed →
   done/failed`, lease, `command_id`) instead of commands inside the event log.
   Implemented as `sync_commands` + `/api/sync/commands{,/claim,/complete}`
   (Cloud) and the `routes::cloud_commands` consumer (Desktop backend). Mobile
   `chat_command`/`workspace_request`/`issue` pushes are queued automatically
   (old APKs keep working) and routed to the owning instance
   (`desktop:<instance_id>` record source, kept when Mobile writes). Card
   moves carry the `updated_at` Mobile saw as base revision: applied unless
   the card changed locally after it — the old mirror compared that unchanged
   timestamp and dropped every move made from the phone. The webview still
   mirrors card moves from other instances until phase 5.
4. **Push and retention (done).** Pushes and command enqueue/release fire
   `pg_notify` in their transaction plus an in-process signal; long-polls
   wake on it and re-check only every 1–2 s (no client change needed, so no
   SSE/WS yet). Events are kept 7 days per account (pruned hourly at most);
   `min_revision` marks the oldest kept and a stale cursor gets `reset: true`
   to re-snapshot. Finished commands past retention are removed.
5. **Teams.** Partition by `scope_id` (team/project) with membership ACL;
   board writes carry `base_revision` (optimistic concurrency) instead of
   wall-clock `updated_at` last-writer-wins.

Off-the-shelf engines (ElectricSQL — the web client already speaks its shapes
— or PowerSync) remain an option for real-time multi-person collaboration;
the in-house path reuses existing pieces and is preferred for now.

## Consequences

- Phase 1 removes lost/duplicated events, replayed prompts and the truncated
  seed without changing wire formats; old clients keep working (legacy
  snapshot, `after_revision` numeric, commands without `command_id`).
- Existing duplicate revisions in production are not renumbered; uniqueness
  holds for new revisions by construction.
- Until phase 2, the Desktop still exports the full context per event; the
  Cloud now drops unchanged records before allocating revisions, so the cost
  is bandwidth and Desktop CPU, not event-log growth.
- Until phase 5, two instances publishing the same board can still overwrite
  each other with stale state.
