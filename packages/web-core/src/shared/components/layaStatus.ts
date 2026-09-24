import type { LayaExecutionMode } from '@/shared/stores/useUiPreferencesStore';

export type LayaProbeState = 'checking' | 'online' | 'offline' | 'unauthorized';

export interface LayaStatusSnapshot {
  mode: LayaExecutionMode;
  state: LayaProbeState;
  endpoint: string;
  latencyMs?: number;
  error?: string;
}

// Same dot palette as Mem0StatusIndicator: green reachable, orange needs
// attention (missing Cloud sign-in), red down, gray still checking.
export const LAYA_PROBE_COLORS: Record<LayaProbeState, string> = {
  checking: '#9ca3af',
  online: '#22c55e',
  unauthorized: '#f97316',
  offline: '#ef4444',
};

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
  lines.push('', 'Click to open Settings → Usage (Laya execution mode).');
  return lines.join('\n');
}
