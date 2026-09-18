import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { makeRequest } from '@/shared/lib/remoteApi';
import { handleApiResponse } from '@/shared/lib/api';

export interface Mem0ProviderCfg {
  url: string;
  model: string;
  has_key: boolean;
}

export interface Mem0Config {
  ok: boolean;
  provider: string;
  graph_enabled: boolean;
  graph_url: string;
  collection: string;
  providers: Record<string, Mem0ProviderCfg>;
}

interface Mem0Connection {
  source: 'local' | 'cloud';
  url: string;
  local_url: string;
  cloud_url: string;
  enabled: boolean;
  adapter: 'mem0_vk' | 'mem0_platform';
  mem0_api_key_configured: boolean;
  qdrant_url: string;
  qdrant_api_key_configured: boolean;
  embedding_dimensions: number;
}

type MigrationAdapter = 'mem0_vk' | 'mem0_platform';
type MemoryHostingMode = 'self-hosted' | 'cloud';

interface CloudAccountSnapshot {
  email?: string;
  userId?: string;
  accessToken?: string;
  memory?: {
    enabled: boolean;
    gatewayUrl: string;
    plan: 'free' | 'personal' | 'enterprise';
  };
}

interface MemoryMigrationResult {
  mode: 'preview' | 'execute';
  user_id: string;
  source_count: number;
  destination_existing: number;
  would_migrate: number;
  queued: number;
  skipped_duplicates: number;
  failed: string[];
  warnings: string[];
}

const PROVIDER_ORDER = ['groq', 'openrouter', 'llama', 'openai'] as const;
const CLOUD_ACCOUNT_STORAGE_KEY = 'aurapunk-cloud-account';

/**
 * The hosted AuraPunk Cloud gateway is always the `/api/memory/v1` suffix on
 * the configured URL. Detecting it from the URL (the actual persisted config)
 * keeps Settings ↔ config in sync instead of guessing from the browser's
 * account snapshot.
 */
function isAuraPunkCloudUrl(url: string): boolean {
  return url.replace(/\/+$/, '').endsWith('/api/memory/v1');
}

function readCloudAccount(): CloudAccountSnapshot | null {
  try {
    const raw = window.localStorage.getItem(CLOUD_ACCOUNT_STORAGE_KEY);
    if (!raw) return null;
    const account = JSON.parse(raw) as CloudAccountSnapshot;
    return account.accessToken ? account : null;
  } catch {
    return null;
  }
}

async function fetchMem0Config(): Promise<Mem0Config> {
  const response = await makeRequest('/api/usage/mem0-config', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Config>(response);
}

async function updateMem0Config(body: {
  provider?: string;
  graph_enabled?: boolean;
  providers?: Record<string, { url?: string; model?: string; key?: string }>;
}): Promise<Mem0Config> {
  const response = await makeRequest('/api/usage/mem0-config', {
    method: 'POST',
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Config>(response);
}

async function fetchMem0Connection(): Promise<Mem0Connection> {
  const response = await makeRequest('/api/usage/mem0-connection', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Connection>(response);
}

async function updateMem0Connection(
  body: Partial<{
    source: Mem0Connection['source'];
    adapter: Mem0Connection['adapter'];
    enabled: boolean;
    url: string;
    cloud_vector_only: boolean;
    mem0_api_key: string;
    qdrant_url: string;
    qdrant_api_key: string;
    qdrant_collection: string;
    embedding_dimensions: number;
  }>
): Promise<Mem0Connection> {
  const response = await makeRequest('/api/usage/mem0-connection', {
    method: 'PUT',
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Connection>(response);
}

async function migrateMemories(body: {
  source: { adapter: MigrationAdapter; url: string; api_key: string };
  destination: { adapter: MigrationAdapter; url: string; api_key: string };
  user_id: string;
  mode: 'preview' | 'execute';
  confirm: boolean;
}): Promise<MemoryMigrationResult> {
  const response = await makeRequest('/api/usage/memory-migration', {
    method: 'POST',
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return handleApiResponse<MemoryMigrationResult>(response);
}

interface ProviderDraft {
  url: string;
  model: string;
  key: string;
}

export function MemorySettingsSection() {
  const { t } = useTranslation('settings');
  const [config, setConfig] = useState<Mem0Config | null>(null);
  const [connection, setConnection] = useState<Mem0Connection | null>(null);
  const [hostingMode, setHostingMode] =
    useState<MemoryHostingMode>('self-hosted');
  const [cloudAccount, setCloudAccount] = useState<CloudAccountSnapshot | null>(
    () => readCloudAccount()
  );
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [adapter, setAdapter] = useState<Mem0Connection['adapter']>('mem0_vk');
  const [mem0ApiKey, setMem0ApiKey] = useState('');
  const [qdrantUrl, setQdrantUrl] = useState('');
  const [qdrantApiKey, setQdrantApiKey] = useState('');
  const [selfManagedUrl, setSelfManagedUrl] = useState('');
  const [embeddingDimensions, setEmbeddingDimensions] = useState(384);
  const [provider, setProvider] = useState('groq');
  const [graphEnabled, setGraphEnabled] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [migrationSourceAdapter, setMigrationSourceAdapter] =
    useState<MigrationAdapter>('mem0_vk');
  const [migrationDestinationAdapter, setMigrationDestinationAdapter] =
    useState<MigrationAdapter>('mem0_platform');
  const [migrationSourceUrl, setMigrationSourceUrl] = useState(
    'http://localhost:8000'
  );
  const [migrationDestinationUrl, setMigrationDestinationUrl] = useState(
    'https://api.mem0.ai'
  );
  const [migrationSourceKey, setMigrationSourceKey] = useState('');
  const [migrationDestinationKey, setMigrationDestinationKey] = useState('');
  const [migrationUserId, setMigrationUserId] = useState('');
  const [migrationConfirm, setMigrationConfirm] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationResult, setMigrationResult] =
    useState<MemoryMigrationResult | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const cfg = await fetchMem0Config();
      setConfig(cfg);
      setProvider(cfg.provider);
      setGraphEnabled(cfg.graph_enabled);
      const draftsInit: Record<string, ProviderDraft> = {};
      for (const p of PROVIDER_ORDER) {
        const pc = cfg.providers[p] ?? { url: '', model: '', has_key: false };
        draftsInit[p] = { url: pc.url, model: pc.model, key: '' };
      }
      setDrafts(draftsInit);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load memory config');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchMem0Connection()
      .then((next) => {
        setConnection(next);
        setEnabled(next.enabled);
        setAdapter(next.adapter);
        // The config itself decides which hosting mode is active: a URL on the
        // AuraPunk Cloud gateway is Cloud, anything else is self-hosted. The
        // account snapshot only decorates the Cloud card with the signed-in
        // email/plan — it must not flip the selected mode.
        setHostingMode(isAuraPunkCloudUrl(next.url) ? 'cloud' : 'self-hosted');
        setSelfManagedUrl(
          next.source === 'cloud' && !isAuraPunkCloudUrl(next.url)
            ? next.url
            : next.cloud_url
        );
        setQdrantUrl(next.qdrant_url);
        setEmbeddingDimensions(next.embedding_dimensions);
        if (next.adapter === 'mem0_vk') {
          setMigrationSourceUrl(next.url);
          setMigrationSourceAdapter('mem0_vk');
        }
        // Refresh the always-visible indicator when Settings is opened after
        // the packaged client has applied a persisted Cloud handoff.
        window.dispatchEvent(new Event('mem0-connection-changed'));
      })
      .catch((e: unknown) => {
        setError(
          e instanceof Error ? e.message : 'Failed to load memory connection'
        );
      });
  }, []);

  useEffect(() => {
    const refreshCloudAccount = () => setCloudAccount(readCloudAccount());
    window.addEventListener(
      'aurapunk-cloud-account-changed',
      refreshCloudAccount
    );
    return () =>
      window.removeEventListener(
        'aurapunk-cloud-account-changed',
        refreshCloudAccount
      );
  }, []);

  const handleMigration = async (mode: 'preview' | 'execute') => {
    setMigrationBusy(true);
    setError(null);
    try {
      const result = await migrateMemories({
        source: {
          adapter: migrationSourceAdapter,
          url: migrationSourceUrl,
          api_key: migrationSourceKey,
        },
        destination: {
          adapter: migrationDestinationAdapter,
          url: migrationDestinationUrl,
          api_key: migrationDestinationKey,
        },
        user_id: migrationUserId.trim(),
        mode,
        confirm: mode === 'execute' && migrationConfirm,
      });
      setMigrationResult(result);
      if (mode === 'execute') {
        setMigrationConfirm(false);
        setMigrationSourceKey('');
        setMigrationDestinationKey('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Memory migration failed');
    } finally {
      setMigrationBusy(false);
    }
  };

  const setDraft = (p: string, field: keyof ProviderDraft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [p]: { ...(prev[p] ?? { url: '', model: '', key: '' }), [field]: value },
    }));
  };

  const handleSave = async () => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const nextConnection = await updateMem0Connection({
        enabled,
        adapter,
        ...(mem0ApiKey ? { mem0_api_key: mem0ApiKey } : {}),
        qdrant_url: qdrantUrl,
        ...(qdrantApiKey ? { qdrant_api_key: qdrantApiKey } : {}),
        embedding_dimensions: embeddingDimensions,
      });
      setConnection(nextConnection);
      setMem0ApiKey('');
      setQdrantApiKey('');
      window.dispatchEvent(new Event('mem0-connection-changed'));

      if (enabled && adapter === 'mem0_vk') {
        const providers: Record<
          string,
          { url: string; model: string; key?: string }
        > = {};
        for (const p of PROVIDER_ORDER) {
          const d = drafts[p] ?? { url: '', model: '', key: '' };
          const patch: { url: string; model: string; key?: string } = {
            url: d.url,
            model: d.model,
          };
          // Only send a key when the user typed a new one — the server keeps the
          // existing masked key otherwise.
          if (d.key) patch.key = d.key;
          providers[p] = patch;
        }
        const cfg = await updateMem0Config({
          provider,
          graph_enabled: graphEnabled,
          providers,
        });
        setConfig(cfg);
      }
      setSaved(true);
      // Re-run the re-extract check: toggling the graph or a provider can make
      // previously-stored memories extractable.
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save memory config');
    } finally {
      setBusy(false);
    }
  };

  const handleConnectionChange = async (source: Mem0Connection['source']) => {
    const cloudMemory = source === 'cloud' ? cloudAccount?.memory : undefined;
    const cloudAlreadyConfigured =
      source === 'cloud' &&
      connection?.source === 'cloud' &&
      connection?.url === cloudMemory?.gatewayUrl &&
      connection?.enabled;
    if (
      !connection ||
      (connection.source === source &&
        (source !== 'cloud' || cloudAlreadyConfigured))
    ) {
      return;
    }
    if (
      source === 'cloud' &&
      (!cloudMemory?.enabled || !cloudMemory.gatewayUrl)
    ) {
      setCloudNotice(
        'Cloud memory is not available on the current AuraPunk account.'
      );
      return;
    }
    setConnectionBusy(true);
    setError(null);
    try {
      const next = await updateMem0Connection({
        source,
        // Both self-hosted sub-sources use the AuraPunk mem0-vk contract.
        adapter: 'mem0_vk',
        ...(cloudMemory
          ? {
              enabled: true,
              url: cloudMemory.gatewayUrl,
              cloud_vector_only: cloudMemory.plan === 'free',
              ...(cloudAccount?.accessToken
                ? { mem0_api_key: cloudAccount.accessToken }
                : {}),
            }
          : {}),
      });
      setConnection(next);
      setEnabled(next.enabled);
      setAdapter(next.adapter);
      window.dispatchEvent(new Event('mem0-connection-changed'));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to switch memory source'
      );
    } finally {
      setConnectionBusy(false);
    }
  };

  /**
   * Self-hosted sub-source switch (Local Docker vs a Mem0 server you run).
   * Deliberately does NOT touch the AuraPunk Cloud account: "cloud" here is a
   * self-managed endpoint, not the hosted gateway. Bug before this: selecting
   * it demanded a signed-in AuraPunk account and silently rewrote the URL to
   * the Cloud gateway, so a self-managed server could never be selected.
   */
  const handleSelfManagedSourceChange = async (
    source: Mem0Connection['source']
  ) => {
    if (!connection || connectionBusy) return;
    const selfManagedUrlValue =
      source === 'cloud'
        ? (selfManagedUrl.trim() || connection.cloud_url).trim()
        : null;
    if (
      selfManagedUrlValue &&
      !selfManagedUrlValue.startsWith('http://') &&
      !selfManagedUrlValue.startsWith('https://')
    ) {
      setError('Self-managed Mem0 URL must start with http:// or https://');
      return;
    }
    setConnectionBusy(true);
    setError(null);
    try {
      const next = await updateMem0Connection({
        source,
        adapter: 'mem0_vk',
        enabled: true,
        ...(selfManagedUrlValue ? { url: selfManagedUrlValue } : {}),
      });
      setConnection(next);
      setEnabled(next.enabled);
      setAdapter(next.adapter);
      window.dispatchEvent(new Event('mem0-connection-changed'));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to switch memory source'
      );
    } finally {
      setConnectionBusy(false);
    }
  };

  const handleHostingModeChange = (mode: MemoryHostingMode) => {
    setCloudNotice(null);
    const cloudMemoryAvailable = Boolean(
      cloudAccount?.memory?.enabled && cloudAccount.memory.gatewayUrl
    );
    if (mode === 'cloud' && !cloudMemoryAvailable) {
      setCloudNotice(
        cloudAccount
          ? 'Cloud authorization is incomplete. Sign in again to authorize this Desktop.'
          : 'Cloud memory requires an AuraPunk account. Sign in to continue.'
      );
      window.dispatchEvent(new Event('aurapunk-cloud-login-request'));
      return;
    }

    setHostingMode(mode);
    if (mode === 'cloud') {
      void handleConnectionChange('cloud');
    }
  };

  const providerLabel = (p: string): string => {
    switch (p) {
      case 'groq':
        return 'Groq';
      case 'openrouter':
        return 'OpenRouter';
      case 'llama':
        return 'Local llama (OpenAI /v1)';
      case 'openai':
        return 'OpenAI-compatible (DeepSeek, NVIDIA…)';
      default:
        return p;
    }
  };

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      {error && (
        <div className="rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}
      {!config && !error && (
        <div className="text-sm text-low">
          {t('settings.memory.loading', 'Loading memory config…')}
        </div>
      )}

      {config && (
        <>
          {connection && (
            <div className="rounded-sm border border-border bg-panel p-3">
              <div className="text-sm font-medium text-high">
                Memory hosting
              </div>
              <div className="mt-1 text-xs text-low">
                Choose between your own Mem0 deployment and AuraPunk Cloud.
                Cloud memory is available only after signing in.
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={hostingMode === 'self-hosted'}
                  onClick={() => handleHostingModeChange('self-hosted')}
                  className={`rounded-sm border px-3 py-3 text-left transition-colors ${
                    hostingMode === 'self-hosted'
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border bg-secondary text-normal hover:bg-secondary/80'
                  }`}
                >
                  <span className="block text-sm font-medium">Self-hosted</span>
                  <span className="mt-1 block text-xs text-low">
                    Configure Local Mem0 or a Mem0 server you control.
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={hostingMode === 'cloud'}
                  onClick={() => handleHostingModeChange('cloud')}
                  className={`rounded-sm border px-3 py-3 text-left transition-colors ${
                    hostingMode === 'cloud'
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border bg-secondary text-normal hover:bg-secondary/80'
                  }`}
                >
                  <span className="block text-sm font-medium">
                    AuraPunk Cloud
                  </span>
                  <span className="mt-1 block text-xs text-low">
                    {cloudAccount?.memory?.enabled
                      ? `Available${cloudAccount.email ? ` for ${cloudAccount.email}` : ''}.`
                      : 'Sign in to unlock your included cloud memory.'}
                  </span>
                </button>
              </div>
              {cloudNotice && (
                <div
                  role="status"
                  className="mt-3 rounded-sm border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-brand"
                >
                  {cloudNotice}
                </div>
              )}
            </div>
          )}

          {connection && hostingMode === 'self-hosted' && (
            <div className="rounded-sm border border-border bg-panel p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-high">
                    Memory endpoints
                  </div>
                  <div className="mt-1 text-xs text-low">
                    Disable this to stop memory MCP calls without removing the
                    saved credentials.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => setEnabled((value) => !value)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    enabled ? 'bg-brand' : 'bg-secondary'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                      enabled ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              <div className="mt-4 text-sm font-medium text-high">
                Memory adapter
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(
                  [
                    [
                      'mem0_vk',
                      'AuraPunk Mem0 adapter',
                      'Local or self-managed server + your Qdrant',
                    ],
                    [
                      'mem0_platform',
                      'Mem0 Platform',
                      'API gerenciada da Mem0',
                    ],
                  ] as const
                ).map(([value, label, description]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={adapter === value}
                    onClick={() => setAdapter(value)}
                    className={`rounded-sm border px-3 py-2 text-left transition-colors ${
                      adapter === value
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border bg-secondary text-normal hover:bg-secondary/80'
                    }`}
                  >
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="mt-1 block text-xs text-low">
                      {description}
                    </span>
                  </button>
                ))}
              </div>

              <label className="mt-3 block text-xs text-low">
                Mem0 API key
                <input
                  type="password"
                  value={mem0ApiKey}
                  onChange={(event) => setMem0ApiKey(event.target.value)}
                  placeholder={
                    connection.mem0_api_key_configured
                      ? '•••••••••• (saved)'
                      : 'Token / API key'
                  }
                  autoComplete="off"
                  className="mt-1 w-full rounded-sm border border-border bg-secondary px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </label>

              {adapter === 'mem0_vk' ? (
                <div className="mt-3 rounded-sm border border-border bg-secondary/40 p-2">
                  <div className="text-xs font-medium text-normal">
                    Qdrant (self-hosted adapter)
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input
                      type="url"
                      value={qdrantUrl}
                      onChange={(event) => setQdrantUrl(event.target.value)}
                      placeholder="Qdrant URL"
                      className="min-w-0 rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                    <input
                      type="password"
                      value={qdrantApiKey}
                      onChange={(event) => setQdrantApiKey(event.target.value)}
                      placeholder={
                        connection.qdrant_api_key_configured
                          ? '•••••••••• (saved)'
                          : 'Qdrant API key'
                      }
                      autoComplete="off"
                      className="min-w-0 rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                    <input
                      type="number"
                      min={1}
                      max={8192}
                      value={embeddingDimensions}
                      onChange={(event) =>
                        setEmbeddingDimensions(
                          Number(event.target.value) || 384
                        )
                      }
                      placeholder="Dimensions"
                      className="min-w-0 rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                    />
                  </div>
                  <div className="mt-2 text-xs text-low">
                    A dimensão deve ser igual à do modelo de embeddings. O
                    padrão deste projeto é 384.
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded-sm border border-brand/20 bg-brand/5 px-3 py-2 text-xs text-low">
                  O Platform gerencia extração, embeddings, índice vetorial e
                  processamento assíncrono. As credenciais do Qdrant não se
                  aplicam neste adapter.
                </div>
              )}
            </div>
          )}

          {connection &&
            hostingMode === 'self-hosted' &&
            adapter === 'mem0_vk' && (
              <div className="rounded-sm border border-border bg-panel p-3">
                <div className="text-sm font-medium text-high">
                  Memory source
                </div>
                <div className="mt-1 text-xs text-low">
                  Choose which Mem0 service new agent runs should use.
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(
                    [
                      ['local', 'Local Mem0 (Docker)', connection.local_url],
                      [
                        'cloud',
                        'Self-managed Mem0 server',
                        selfManagedUrl || connection.cloud_url,
                      ],
                    ] as const
                  ).map(([source, label, url]) => (
                    <button
                      key={source}
                      type="button"
                      aria-pressed={connection.source === source}
                      disabled={connectionBusy}
                      onClick={() => void handleSelfManagedSourceChange(source)}
                      className={`rounded-sm border px-3 py-2 text-left transition-colors ${
                        connection.source === source
                          ? 'border-brand bg-brand/10 text-brand'
                          : 'border-border bg-secondary text-normal hover:bg-secondary/80'
                      } disabled:opacity-50`}
                    >
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="mt-1 block truncate text-xs text-low">
                        {url}
                      </span>
                    </button>
                  ))}
                </div>
                <label className="mt-3 block text-xs text-low">
                  Self-managed Mem0 server URL
                  <input
                    type="url"
                    value={selfManagedUrl}
                    onChange={(event) => setSelfManagedUrl(event.target.value)}
                    placeholder={connection.cloud_url}
                    className="mt-1 w-full rounded-sm border border-border bg-secondary px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </label>
                <div className="mt-2 text-xs text-low">
                  Current: <span className="text-normal">{connection.url}</span>
                  . Selecting a source switches new agent runs; AuraPunk Cloud
                  uses your signed-in account instead.
                </div>
              </div>
            )}

          {hostingMode === 'cloud' && !cloudAccount && connection && (
            <div
              role="status"
              className="rounded-sm border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-brand"
            >
              This Desktop is configured for AuraPunk Cloud memory, but no
              account is connected. Sign in and select AuraPunk Cloud again —
              hosted memory requires account authorization.
            </div>
          )}

          {hostingMode === 'cloud' && cloudAccount && connection && (
            <div className="rounded-sm border border-brand/30 bg-brand/5 p-3">
              <div className="text-sm font-medium text-high">
                {connection.source === 'cloud' &&
                connection.enabled &&
                connection.url === cloudAccount.memory?.gatewayUrl
                  ? 'AuraPunk Cloud memory connected'
                  : 'AuraPunk Cloud account signed in; memory is not connected'}
              </div>
              <div className="mt-1 text-xs text-low">
                {cloudAccount.email
                  ? `Signed in as ${cloudAccount.email}. `
                  : ''}
                {connection.source === 'cloud' &&
                connection.enabled &&
                connection.url === cloudAccount.memory?.gatewayUrl
                  ? 'Requests use the AuraPunk Cloud memory gateway.'
                  : 'Select AuraPunk Cloud again to apply the gateway to this Desktop.'}{' '}
                Use Self-hosted to choose Local Mem0 or your own Mem0 server.
              </div>
            </div>
          )}

          {hostingMode === 'self-hosted' && adapter === 'mem0_vk' && (
            <>
              <div className="rounded-sm border border-border bg-panel p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-high">
                      {t('settings.memory.graph', 'Memory graph')}
                    </div>
                    <div className="text-xs text-low">
                      {config.graph_url
                        ? `mem0 · ${config.collection} · ${config.graph_url}`
                        : t(
                            'settings.memory.graphDisabled',
                            'Graph service not configured'
                          )}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={graphEnabled}
                    onClick={() => setGraphEnabled((v) => !v)}
                    className={`relative h-6 w-11 rounded-full transition-colors ${
                      graphEnabled ? 'bg-brand' : 'bg-secondary'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                        graphEnabled ? 'left-[22px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </div>
                <div className="mt-2 text-xs text-low">
                  {t(
                    'settings.memory.graphHint',
                    'When off, memories are stored and searched as vectors only; no graph is built or persisted.'
                  )}
                </div>
              </div>

              <div className="rounded-sm border border-border bg-panel p-3">
                <label className="mb-1 block text-xs text-low">
                  {t(
                    'settings.memory.provider',
                    'Extraction provider (primary)'
                  )}
                </label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full rounded-sm border border-border bg-secondary px-2 py-1.5 text-sm text-high focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  {PROVIDER_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p)}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-xs text-low">
                  {t(
                    'settings.memory.providerHint',
                    'Configured providers are tried in order when the primary is rate-limited or fails.'
                  )}
                </div>
              </div>

              <div className="rounded-sm border border-border bg-panel p-3">
                <div className="mb-2 text-sm font-medium text-high">
                  {t('settings.memory.providers', 'Providers & API keys')}
                </div>
                <div className="flex flex-col gap-4">
                  {PROVIDER_ORDER.map((p) => {
                    const d = drafts[p] ?? { url: '', model: '', key: '' };
                    const hasKey = config.providers[p]?.has_key ?? false;
                    return (
                      <div key={p} className="rounded-sm bg-secondary/40 p-2">
                        <div className="mb-1 text-xs font-medium text-normal">
                          {providerLabel(p)}
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <input
                            type="text"
                            value={d.url}
                            onChange={(e) => setDraft(p, 'url', e.target.value)}
                            placeholder={t(
                              'settings.memory.baseUrl',
                              'Base URL'
                            )}
                            className="min-w-0 rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                          />
                          <input
                            type="text"
                            value={d.model}
                            onChange={(e) =>
                              setDraft(p, 'model', e.target.value)
                            }
                            placeholder={t('settings.memory.model', 'Model')}
                            className="min-w-0 rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                          />
                          <div className="relative">
                            <input
                              type="password"
                              value={d.key}
                              onChange={(e) =>
                                setDraft(p, 'key', e.target.value)
                              }
                              placeholder={
                                hasKey
                                  ? '•••••••••• (saved)'
                                  : t('settings.memory.apiKey', 'API key')
                              }
                              autoComplete="off"
                              className="min-w-0 w-full rounded-sm border border-border bg-panel px-2 py-1.5 pr-9 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                            />
                            {hasKey && (
                              <span
                                title={t(
                                  'settings.memory.keySaved',
                                  'Key saved'
                                )}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-success"
                              >
                                ●
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 text-xs text-low">
                  {t(
                    'settings.memory.keysHint',
                    'API keys are stored in the mem0 container and never shown again — only a "saved" indicator is returned. Leave a key field empty to keep the existing one.'
                  )}
                </div>
              </div>
            </>
          )}

          {hostingMode === 'self-hosted' && (
            <div className="rounded-sm border border-border bg-panel p-3">
              <div className="text-sm font-medium text-high">
                Migrate project memories
              </div>
              <div className="mt-1 text-xs text-low">
                Preview first. The source is never deleted, credentials are used
                only for this operation, and duplicate facts are skipped.
                Destination memories are re-extracted by their own adapter.
              </div>

              <label className="mt-3 block text-xs text-low">
                Project / repository slug (`user_id`)
                <input
                  type="text"
                  value={migrationUserId}
                  onChange={(event) => setMigrationUserId(event.target.value)}
                  placeholder="vibe-kanban-alternative"
                  className="mt-1 w-full rounded-sm border border-border bg-secondary px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </label>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                {(
                  [
                    ['source', 'Source'],
                    ['destination', 'Destination'],
                  ] as const
                ).map(([side, label]) => {
                  const isSource = side === 'source';
                  const selectedAdapter = isSource
                    ? migrationSourceAdapter
                    : migrationDestinationAdapter;
                  const selectedUrl = isSource
                    ? migrationSourceUrl
                    : migrationDestinationUrl;
                  const selectedKey = isSource
                    ? migrationSourceKey
                    : migrationDestinationKey;
                  return (
                    <div
                      key={side}
                      className="rounded-sm border border-border bg-secondary/40 p-2"
                    >
                      <div className="text-xs font-medium text-normal">
                        {label}
                      </div>
                      <select
                        value={selectedAdapter}
                        onChange={(event) => {
                          const value = event.target.value as MigrationAdapter;
                          if (isSource) setMigrationSourceAdapter(value);
                          else setMigrationDestinationAdapter(value);
                        }}
                        className="mt-2 w-full rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high focus:outline-none focus:ring-1 focus:ring-brand"
                      >
                        <option value="mem0_vk">mem0_vk (self-hosted)</option>
                        <option value="mem0_platform">
                          Mem0 Platform (cloud)
                        </option>
                      </select>
                      <input
                        type="url"
                        value={selectedUrl}
                        onChange={(event) => {
                          if (isSource)
                            setMigrationSourceUrl(event.target.value);
                          else setMigrationDestinationUrl(event.target.value);
                        }}
                        placeholder="https://endpoint"
                        className="mt-2 w-full rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                      <input
                        type="password"
                        value={selectedKey}
                        onChange={(event) => {
                          if (isSource)
                            setMigrationSourceKey(event.target.value);
                          else setMigrationDestinationKey(event.target.value);
                        }}
                        placeholder="API key (if required)"
                        autoComplete="off"
                        className="mt-2 w-full rounded-sm border border-border bg-panel px-2 py-1.5 text-xs text-high placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={migrationBusy || !migrationUserId.trim()}
                  onClick={() => void handleMigration('preview')}
                  className="rounded-sm border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-high hover:bg-secondary/80 disabled:opacity-50"
                >
                  {migrationBusy ? 'Working…' : 'Preview migration'}
                </button>
                <label className="flex items-center gap-2 text-xs text-low">
                  <input
                    type="checkbox"
                    checked={migrationConfirm}
                    onChange={(event) =>
                      setMigrationConfirm(event.target.checked)
                    }
                    className="accent-brand"
                  />
                  I reviewed the preview and want to enqueue the copy
                </label>
                <button
                  type="button"
                  disabled={
                    migrationBusy ||
                    !migrationUserId.trim() ||
                    !migrationConfirm
                  }
                  onClick={() => void handleMigration('execute')}
                  className="rounded-sm bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand/90 disabled:opacity-50"
                >
                  Execute migration
                </button>
              </div>

              {migrationResult && (
                <div className="mt-3 rounded-sm border border-border bg-secondary/40 p-2 text-xs text-low">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <span>Source: {migrationResult.source_count}</span>
                    <span>
                      Existing: {migrationResult.destination_existing}
                    </span>
                    <span>To copy: {migrationResult.would_migrate}</span>
                    <span>Queued: {migrationResult.queued}</span>
                    <span>
                      Duplicates: {migrationResult.skipped_duplicates}
                    </span>
                    <span>Failures: {migrationResult.failed.length}</span>
                  </div>
                  {migrationResult.warnings.map((warning) => (
                    <div key={warning} className="mt-2 text-warning">
                      {warning}
                    </div>
                  ))}
                  {migrationResult.failed.map((failure) => (
                    <div key={failure} className="mt-2 text-error">
                      {failure}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hostingMode === 'self-hosted' && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={busy}
                className="rounded-sm bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
              >
                {busy
                  ? t('settings.memory.saving', 'Saving…')
                  : t('settings.memory.save', 'Save memory config')}
              </button>
              {saved && (
                <span className="text-sm text-success">
                  {t('settings.memory.saved', 'Saved')}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
