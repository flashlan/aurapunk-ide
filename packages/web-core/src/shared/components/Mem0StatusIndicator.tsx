import { useCallback, useEffect, useRef, useState } from 'react';
import { DatabaseIcon } from '@phosphor-icons/react';
import { makeRequest, handleApiResponse } from '@/shared/lib/api';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { Tooltip } from '@vibe/ui/components/Tooltip';

type Mem0Level = 'green' | 'yellow' | 'orange' | 'red' | 'disabled';

interface Mem0ComponentStatus {
  mem0: boolean;
  embeddings: boolean;
  qdrant: boolean;
}

interface Mem0StatusResponse {
  level: Mem0Level;
  components: Mem0ComponentStatus;
  message: string;
  connection?: Mem0Connection;
}

interface Mem0Connection {
  source: 'local' | 'cloud';
  url: string;
  local_url: string;
  cloud_url: string;
  enabled: boolean;
  adapter: 'mem0_vk' | 'mem0_platform';
}

const LEVEL_COLOR: Record<Mem0Level, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
  disabled: '#9ca3af',
};

const LEVEL_LABEL: Record<Mem0Level, string> = {
  green: 'Operational',
  yellow: 'Degraded (graph)',
  orange: 'Degraded (backend)',
  red: 'Unavailable',
  disabled: 'Disabled',
};

const POLL_INTERVAL_MS = 30_000;

function componentLine(label: string, ok: boolean): string {
  return `${ok ? '✓' : '⚠'} ${label}`;
}

/**
 * Always-visible mem0 health dot for the app header. Polls
 * `GET /api/usage/mem0-status` every 30s and reflects the computed 4-level
 * health (green/yellow/orange/red) as a colored dot + tooltip. Clicking it
 * opens Settings → Memory so the user can inspect or switch the connection.
 *
 * Best-effort: a failed poll (server down, transient error) leaves the last
 * known status intact rather than flickering the indicator — memory_save /
 * memory_search degrade gracefully on their own, this is purely a signal.
 */
export function Mem0StatusIndicator() {
  const [status, setStatus] = useState<Mem0StatusResponse | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const response = await makeRequest('/api/usage/mem0-status', {
        cache: 'no-store',
      });
      const data = await handleApiResponse<Mem0StatusResponse>(response);
      if (data) setStatus(data);
    } catch {
      // Keep last-known status on transient errors.
    }
  }, []);

  useEffect(() => {
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll]);

  useEffect(() => {
    const handleConnectionChange = () => void poll();
    window.addEventListener('mem0-connection-changed', handleConnectionChange);
    window.addEventListener(
      'aurapunk-cloud-account-changed',
      handleConnectionChange
    );
    return () => {
      window.removeEventListener(
        'mem0-connection-changed',
        handleConnectionChange
      );
      window.removeEventListener(
        'aurapunk-cloud-account-changed',
        handleConnectionChange
      );
    };
  }, [poll]);

  const level: Mem0Level = status?.level ?? 'green';
  const components = status?.components;
  const color = status ? LEVEL_COLOR[level] : '#9ca3af';
  const isAuraPunkCloudGateway = status?.connection?.url
    ?.replace(/\/$/, '')
    .endsWith('/api/memory/v1');
  const isManagedAdapter =
    isAuraPunkCloudGateway || status?.connection?.adapter === 'mem0_platform';
  const tooltip = status
    ? [
        `${LEVEL_LABEL[level]} — ${status.message}`.trim(),
        `Adapter: ${isAuraPunkCloudGateway ? 'AuraPunk Cloud memory' : status.connection?.adapter === 'mem0_platform' ? 'Managed memory (legacy configuration)' : 'Self-hosted mem0-vk'}`,
        isManagedAdapter
          ? ''
          : `Source: ${status.connection?.source === 'cloud' ? 'Cloud / shared server' : 'Local Mem0'}`,
        isAuraPunkCloudGateway
          ? 'Endpoint: AuraPunk Cloud gateway'
          : isManagedAdapter
            ? 'Endpoint: managed by the selected cloud service'
            : status.connection?.url
              ? `Endpoint: ${status.connection.url}`
              : '',
        '',
        componentLine('Mem0', components?.mem0 ?? false),
        componentLine('Embeddings', components?.embeddings ?? false),
        componentLine('Qdrant', components?.qdrant ?? false),
        '',
        'Click to open Settings → Memory',
      ].join('\n')
    : 'Checking Mem0 status…';

  return (
    <Tooltip content={tooltip} side="bottom" className="whitespace-pre-line">
      <button
        type="button"
        onClick={() => SettingsDialog.show({ initialSection: 'memory' })}
        aria-label="Mem0 status"
        title="Mem0 status"
        className="flex size-7 items-center justify-center rounded-sm text-low hover:text-normal"
      >
        <span className="relative flex items-center justify-center">
          <DatabaseIcon className="size-icon-sm" weight="bold" />
          <span
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-1 ring-panel"
            style={{ backgroundColor: color }}
          />
        </span>
      </button>
    </Tooltip>
  );
}
