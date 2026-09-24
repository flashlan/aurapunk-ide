import { useCallback, useEffect, useState } from 'react';
import { CloudIcon, CubeIcon } from '@phosphor-icons/react';
import { Tooltip } from '@vibe/ui/components/Tooltip';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import {
  readCloudAccessToken,
  useLayaCloudUrl,
  useLayaDockerUrl,
  useLayaMode,
} from '@/shared/stores/useUiPreferencesStore';
import { testLayaConnection } from '@/shared/lib/decisionEngineTests';
import {
  LAYA_PROBE_COLORS,
  buildLayaTooltip,
  layaModeLabel,
  resolveLayaEndpoint,
  type LayaProbeState,
} from './layaStatus';

const POLL_INTERVAL_MS = 60_000;

interface LayaProbeResult {
  state: LayaProbeState;
  latencyMs?: number;
  error?: string;
}

/**
 * Always-visible Laya health dot for the sidebar bottom bar, next to the
 * Mem0StatusIndicator. The icon shows the configured execution mode at a
 * glance — CloudIcon for the hosted AuraPunk Cloud gateway, CubeIcon for the
 * local Docker container — and the corner dot reflects reachability:
 * green operational, orange sign-in required (Cloud without a device token),
 * red unreachable, gray checking. Clicking opens Settings → Usage where the
 * Laya execution mode lives.
 *
 * Docker mode polls `testLayaConnection` every 60s (local container, free).
 * Cloud mode only probes on mount and whenever mode/endpoint/token change:
 * the hosted gateway meters extraction calls against the plan quota, so it
 * must not be hit on a timer. Best-effort by design — the tooltip keeps the
 * last probe result instead of flickering.
 */
export function LayaStatusIndicator() {
  const mode = useLayaMode();
  const dockerUrl = useLayaDockerUrl();
  const cloudUrl = useLayaCloudUrl();
  const endpoint = resolveLayaEndpoint(mode, dockerUrl, cloudUrl);
  const [token, setToken] = useState<string | null>(null);
  const [probe, setProbe] = useState<LayaProbeResult>({ state: 'checking' });

  // The Cloud device token is read straight from localStorage, so subscribe
  // to the auth event to pick up sign-in/sign-out without a reload.
  useEffect(() => {
    if (mode !== 'cloud') {
      setToken(null);
      return;
    }
    setToken(readCloudAccessToken());
    const refresh = () => setToken(readCloudAccessToken());
    window.addEventListener('aurapunk-cloud-account-changed', refresh);
    return () =>
      window.removeEventListener('aurapunk-cloud-account-changed', refresh);
  }, [mode]);

  const runProbe = useCallback(async () => {
    if (!endpoint) {
      setProbe({ state: 'offline', error: 'no endpoint configured' });
      return;
    }
    if (mode === 'cloud' && !token) {
      setProbe({ state: 'unauthorized' });
      return;
    }
    const result = await testLayaConnection({
      endpoint,
      headers:
        mode === 'cloud' && token
          ? { Authorization: `Bearer ${token}` }
          : undefined,
    });
    setProbe(
      result.ok
        ? { state: 'online', latencyMs: result.latencyMs }
        : { state: 'offline', error: result.error }
    );
  }, [endpoint, mode, token]);

  useEffect(() => {
    void runProbe();
    // Only the local container is polled on a timer; see the doc comment.
    if (mode === 'cloud') return;
    const timer = setInterval(() => void runProbe(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [runProbe, mode]);

  const ModeIcon = mode === 'cloud' ? CloudIcon : CubeIcon;
  const color = LAYA_PROBE_COLORS[probe.state];
  const tooltip = buildLayaTooltip({
    mode,
    state: probe.state,
    endpoint,
    latencyMs: probe.latencyMs,
    error: probe.error,
  });
  const label = `Laya status — ${layaModeLabel(mode)}`;

  return (
    <Tooltip content={tooltip} side="bottom" className="whitespace-pre-line">
      <button
        type="button"
        onClick={() => SettingsDialog.show({ initialSection: 'usage' })}
        aria-label={label}
        title={label}
        className="flex size-7 items-center justify-center rounded-sm text-low hover:text-normal"
      >
        <span className="relative flex items-center justify-center">
          <ModeIcon className="size-icon-sm" weight="bold" />
          <span
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-1 ring-panel"
            style={{ backgroundColor: color }}
          />
        </span>
      </button>
    </Tooltip>
  );
}
