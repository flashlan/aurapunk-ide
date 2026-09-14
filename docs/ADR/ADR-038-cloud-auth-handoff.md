# ADR-038: Cloud authentication handoff

## Status

Accepted

## Date

2026-08-30

## Context

The desktop app is local-first, while AuraPunk Cloud owns account identity,
tenant membership, billing, and provider authentication. The app must expose
account access in `--cloud` mode without handling passwords or duplicating the
cloud session in a local webview.

## Decision

Cloud authentication actions in the desktop app start a short-lived,
single-use device handoff. The app generates an unpredictable state value and
opens AuraPunk Cloud in the user's browser. The browser completes the hosted
ChatGPT sign-in flow; the cloud site associates the state with the
authenticated account and the app consumes the result through a CORS-enabled
status endpoint. Only the confirmed account identity is returned to the app.
The browser remains the owner of the provider session, and the app never
receives credentials, browser cookies, or provider tokens.

The URL is returned by `/api/app-mode` and can be overridden for self-hosted
deployments with `AURAPUNK_CLOUD_URL`. The default is the official AuraPunk
Cloud URL. The actions are exposed only when the app is launched with
`VIBE_KANBAN_MODE=cloud` (including the `--cloud` desktop launcher mode).

## Consequences

- Local mode remains independent of cloud availability and authentication.
- Login and sign-up actions use the same hosted account system as the site.
- Self-hosted installations can point the app at their own account service.
- The desktop app displays the confirmed account identity locally after the
  one-time handoff. The identity is device-local UI state, not a cloud session.
- Packaged clients start with hosted memory disconnected and contain no
  built-in Mem0 address. After login, the user chooses in a modal between a
  self-hosted endpoint and AuraPunk Cloud memory.
- Confirming Cloud memory installs the device-scoped gateway URL and token
  returned by the authenticated handoff. Declining leaves memory disabled or
  available for manual self-hosted configuration.
- Plan quotas and account namespaces are enforced by the private gateway. The
  desktop never receives a Qdrant address or an internal Mem0 credential.
