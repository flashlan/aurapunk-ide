# ADR-041: Embedded peer bridge for AuraPunk Mobile

## Status

Accepted

## Date

2026-09-03

## Context

AuraPunk Mobile must control a running Desktop instance, stream its console,
and transfer complete APK files without requiring the user to install Tailscale
or another VPN. Sending those bytes through AuraPunk Cloud by default would
turn a local development workflow into recurring egress cost.

The public core is local-first and must not reintroduce the deleted
`remote`/`relay-*` crates. The transport belongs to the Desktop bridge and the
independent Mobile application, while Cloud remains optional rendezvous and
fallback infrastructure.

## Decision

Use the open-source `tailcat` data plane behind an AuraPunk transport adapter.
Tailcat provides the relevant Tailscale components without the Tailscale
control plane: WireGuard encryption, NAT traversal and DERP fallback. Pin an
upstream release or immutable commit and expose only AuraPunk-owned operations
to the rest of the application; do not depend on Tailcat's unstable API or
wire format directly in UI code.

The product connection order is:

1. Direct LAN/UDP peer path when the devices can reach one another.
2. Direct Internet UDP peer path after NAT discovery.
3. Encrypted DERP/relay fallback only when direct paths fail or the user
   explicitly selects relay-only mode.

The first bootstrap path is a local QR invitation. Desktop creates a
single-use invitation valid for two minutes through
`POST /api/mobile/pairing/invite`; Mobile claims it through
`POST /api/mobile/pairing/claim` and stores the returned instance token in the
Android Keystore. The QR contains only the detected private LAN/VPN endpoints
and the temporary invite secret. The packaged Desktop starts a second,
mobile-only LAN listener only when the user clicks **Conectar celular**; the
normal application server remains loopback-only. The listener uses the same
deployment and shuts down with the Desktop. Mobile tries the detected Wi-Fi,
Ethernet, and private WireGuard/Tailscale addresses automatically, so the
user never has to select or type a network interface.

The Desktop distribution includes the bridge runtime. The Android APK
includes the corresponding native bridge/library. Neither path requires a
separate user-installed daemon, VPN, root access, or modified routing table.
Cloud issues short-lived, device-scoped rendezvous data and authorization; it
does not receive peer payload when a direct path is active.

All AuraPunk traffic uses logical channels over the peer tunnel:

- `control`: capabilities, approvals and request IDs;
- `context`: chats, issues, workspaces and job events;
- `terminal`: audited command requests and output;
- `artifact`: resumable APK/file transfer with size, hash and accounting.

APK transfer is direct-first. Before starting, Mobile shows file size,
SHA-256, selected path (`direct` or `relay`) and relay quota impact. The
protocol uses bounded chunks, backpressure, resume offsets and a final hash
check; it never requires buffering the entire APK in Cloud memory.

Relay mode has explicit safeguards: per-request and per-file limits,
per-account byte quotas, rate limiting, expiry/cleanup of incomplete
transfers, and an audit record of bytes sent and received. A relay may use a
separately hosted DERP service or a Cloud endpoint, but relayed bytes are
always metered as infrastructure usage. Large APKs do not bypass cost by
using temporary object storage; storage and egress remain accounted for.

## Consequences

### Positive

- Local and reachable remote devices exchange APKs without AuraPunk Cloud
  bandwidth.
- The user gets a Tailscale-quality data-plane model without installing
  Tailscale or creating a tailnet account.
- Authentication, scopes, approvals and audit remain AuraPunk concerns.
- Relay traffic is a deliberate fallback with visible cost controls.

### Negative / accepted

- Tailcat has no API or wire-format stability promise, so the adapter must pin
  and test a version and carry third-party notices.
- Native packaging is required for Desktop and Android, even though no runtime
  dependency is installed by the user.
- NAT/firewall conditions can still force relay usage; direct connectivity
  cannot be guaranteed on every network.
- Cloud must eventually expose signaling, relay quota and transfer accounting
  endpoints before remote APK transfer is production-ready.

## References

- Tailcat repository and license: <https://github.com/tailscale/tailcat>
- Tailcat architecture: <https://tailscale.com/blog/tailcat>
