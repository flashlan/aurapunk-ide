import type { LayaExecutionMode } from '@/shared/stores/useUiPreferencesStore';

export type LayaProbeState =
  | 'checking'
  | 'online'
  | 'offline'
  | 'unauthorized'
  | 'disabled';

export interface LayaStatusSnapshot {
  mode: LayaExecutionMode;
  state: LayaProbeState;
  endpoint: string;
  latencyMs?: number;
  error?: string;
}

// Same dot palette as Mem0StatusIndicator: green reachable, orange needs
// attention (missing Cloud sign-in), red down, gray still checking or
// deliberately turned off. Disabled and checking share gray on purpose —
// neither is a fault, and a red dot would read as one.
export const LAYA_PROBE_COLORS: Record<LayaProbeState, string> = {
  checking: '#9ca3af',
  online: '#22c55e',
  unauthorized: '#f97316',
  offline: '#ef4444',
  disabled: '#9ca3af',
};

/** Redacted `GET /api/rlcd/config` payload; secrets arrive as booleans. */
export interface RlcdConfigSnapshot {
  engine: 'adaptive' | 'laya' | 'jev';
  laya_url?: string | null;
  jev_url?: string | null;
  has_laya_token?: boolean;
  has_jev_key?: boolean;
}

/**
 * Whether RLCD has at least one classifier target to call. Mirrors
 * `rlcd::targets()`: Laya needs a URL, Jev needs a key, adaptive needs either.
 * With no target the classifier is inert, so the indicator must not report a
 * failure — it is off, not broken.
 */
export function isRlcdConfigured(
  config: RlcdConfigSnapshot | null
): boolean {
  if (!config) return false;
  const laya = Boolean(config.laya_url);
  const jev = Boolean(config.has_jev_key);
  switch (config.engine) {
    case 'laya':
      return laya;
    case 'jev':
      return jev;
    default:
      return laya || jev;
  }
}

export function resolveLayaEndpoint(
  mode: LayaExecutionMode,
  dockerUrl: string,
  cloudUrl: string
): string {
  return mode === 'cloud' ? cloudUrl : dockerUrl;
}

export function layaModeLabel(mode: LayaExecutionMode): string {
  return mode === 'cloud'
    ? 'Cloud (AuraPunk Cloud)'
    : 'Local (Docker container)';
}

function probeLine(snapshot: LayaStatusSnapshot): string {
  switch (snapshot.state) {
    case 'checking':
      return 'Checking Laya status…';
    case 'online':
      return snapshot.latencyMs != null
        ? `Operational (${snapshot.latencyMs} ms)`
        : 'Operational';
    case 'unauthorized':
      return 'Sign-in required';
    case 'disabled':
      return 'Disabled — no decision engine configured';
    case 'offline':
      return snapshot.error ? `Unavailable — ${snapshot.error}` : 'Unavailable';
  }
}

export function buildLayaTooltip(snapshot: LayaStatusSnapshot): string {
  const lines = [
    `Laya — ${layaModeLabel(snapshot.mode)}`,
    probeLine(snapshot),
    snapshot.endpoint
      ? `Endpoint: ${snapshot.endpoint}`
      : 'Endpoint: not configured',
  ];
  if (snapshot.mode === 'cloud' && snapshot.state === 'unauthorized') {
    lines.push(
      'Sign in to AuraPunk Cloud to authorize Laya (Settings → Memory).'
    );
  }
  if (snapshot.state === 'disabled') {
    lines.push(
      'Configure Laya or Jev in Settings → Add-ons to turn the decision engine on.'
    );
  }
  lines.push('', 'Click to open Settings → Usage (Laya execution mode).');
  return lines.join('\n');
}
