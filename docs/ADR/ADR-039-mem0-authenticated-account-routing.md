# ADR-039: Authenticated account routing for Mem0

## Status

Accepted

## Date

2026-08-30

## Context

AuraPunk can use either a local/Docker Mem0 service or the hosted Mem0 service.
The two stores are intentionally incompatible, and hosted memory must not be
available merely because a client knows the service URL. The service needs to
identify the signed-in account and verify an active Personal or Enterprise
license before accepting memory operations.

## Decision

All application and MCP requests to Mem0 use one REST contract:

- `Authorization: Bearer <MEM0_API_TOKEN>` authenticates the application
  service. `GET /health` remains available for health probes.
- `X-AuraPunk-Account-Id` identifies the signed-in AuraPunk account when using
  hosted Mem0.
- Hosted calls terminate at the AuraPunk Cloud memory gateway. It validates a
  revocable device token, resolves the current plan, applies monthly and
  stored-memory quotas, and then forwards to internal Mem0.
- Hosted user namespaces are prefixed with the account ID before reaching
  Qdrant, preventing two accounts from sharing a repo/user namespace.
- The desktop backend stores the current account identity in process state after
  cloud login and clears it on logout. Child MCP processes inherit the same
  environment and apply the same headers.
- Local and hosted memory remain separate. The account service exposes the
  selected backend and its compatibility warning; changing the selection does
  not migrate data.

The bearer token and license-check secrets are deployment configuration, never
source-controlled values. Local/Docker installs may omit the token for
backwards-compatible development, while hosted deployments must configure both
the API token and license-check endpoint/token.

## Consequences

- A leaked Mem0 URL is insufficient to read or modify hosted memories.
- Local installations remain usable without AuraPunk Cloud or D1.
- Account identity is process-scoped in the desktop app, so switching accounts
  requires a logout/login cycle and clears the previous identity.
- The hosted account service must apply the `memory_backend` migration before
  account preference and license endpoints can be used.
- Accounts without an active subscription use the bounded Free quota. An
  expired subscription returns to that quota instead of retaining paid limits.
