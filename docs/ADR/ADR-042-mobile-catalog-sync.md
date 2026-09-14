# ADR-042: Mobile execution-catalog synchronization

## Status

Accepted

## Date

2026-09-11

## Context

The Android client can display a synchronized Kanban board without receiving
the executor models or pipeline definitions required to create a workspace.
Previously, the Desktop published cards, relationships, pipelines, and model
options as one incidental Cloud sync flow. A failure in any part of that flow
could leave the board available while the execution catalog was silently
empty.

The Android client must be able to select an executor/model, select pipeline
stages, and send a workspace request without depending on `vibe-tui`. The
Desktop remains the authority that validates the request, creates the
worktree, and starts the executor. A Cloud request is a queued command and
requires a connected Desktop or an explicitly provisioned Cloud worker.

## Decision

The synchronization has two independent logical channels:

```text
Desktop local API
  ├─ board channel: projects, statuses, issues, workspaces, relations, chat context
  └─ catalog channel: pipelines, stages, executor options/models
          │
          ├─ Cloud /api/sync (account-scoped records)
          └─ Mobile loadKanban()
```

The Desktop publishes both channels with the same account/device token, but a
failure in one channel must not prevent the other from being retried. Catalog
records use the existing `pipeline` and `executor_options` entity types. The
publisher retries transient failures up to three times with backoff and logs
board and catalog failures independently.

The APK treats an empty catalog as a distinct state, reports the received
model/pipeline counts, and sends the selected `model_id`, `pipeline_id`, and
`pipeline_stage_ids` with the workspace request. The Desktop validates those
values against its current local catalog before starting execution.

## Consequences

- Cards can remain usable while the catalog is temporarily unavailable.
- A stale or disconnected Desktop cannot be mistaken for a valid execution
  provider; the APK can report that the catalog is unavailable.
- Cloud execution is not implied by catalog synchronization. Without a Cloud
  worker, a workspace request remains queued for a connected Desktop.
- The next protocol revision should add a catalog revision/hash and
  `published_at` metadata so the APK can distinguish `empty`, `stale`, and
  `ready` catalogs without relying only on record counts.

## Rollout

1. Accept `pipeline` records in the Cloud sync allowlist.
2. Publish board and catalog channels independently with retry.
3. Display counts and catalog status in the APK.
4. Add catalog revision metadata and Desktop-side validation errors in a
   subsequent protocol revision.
