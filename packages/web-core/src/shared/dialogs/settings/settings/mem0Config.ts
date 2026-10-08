/**
 * Pure helpers for the Mem0 add-on panel (`Mem0Panel.tsx`) and the Memory
 * settings section. Network access lives in `mem0Api.ts`; everything here is a
 * value in / value out so it can be unit tested.
 */

/** One extraction provider as the mem0 container reports it. */
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

export type Mem0Adapter = 'mem0_vk' | 'mem0_platform';
export type MigrationAdapter = Mem0Adapter;
export type MemoryHostingMode = 'self-hosted' | 'cloud';

/** How the desktop reaches Mem0, as persisted by `PUT /api/usage/mem0-connection`. */
export interface Mem0Connection {
  source: 'local' | 'cloud';
  url: string;
  local_url: string;
  cloud_url: string;
  enabled: boolean;
  adapter: Mem0Adapter;
  mem0_api_key_configured: boolean;
  qdrant_url: string;
  qdrant_api_key_configured: boolean;
  embedding_dimensions: number;
}

export interface MemoryMigrationResult {
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

/** Extraction providers, in the order the container tries them. */
export const PROVIDER_ORDER = [
  'jev',
  'laya',
  'groq',
  'openrouter',
  'llama',
  'openai',
] as const;

export type Mem0ProviderId = (typeof PROVIDER_ORDER)[number];

/** Must match the embedding model; 384 is this project's default. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export const MEM0_JEV_MODEL = 'jev-latest';

export interface ProviderDraft {
  url: string;
  model: string;
  key: string;
}

export const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  url: '',
  model: '',
  key: '',
};

export function providerLabel(provider: string): string {
  switch (provider) {
    case 'jev':
      return '⚡ Fast Jev (TypeSafe • Zero Tokens)';
    case 'laya':
      return '🧠 Laya Classifier (System-1 • Docker / Cloud)';
    case 'groq':
      return 'Groq (Cloud LLM)';
    case 'openrouter':
      return 'OpenRouter (Cloud LLM)';
    case 'llama':
      return 'Local llama (OpenAI /v1)';
    case 'openai':
      return 'OpenAI-compatible (DeepSeek, NVIDIA…)';
    default:
      return provider;
  }
}

/**
 * The hosted AuraPunk Cloud gateway is always the `/api/memory/v1` suffix on
 * the configured URL. Detecting it from the URL (the actual persisted config)
 * keeps Settings ↔ config in sync instead of guessing from the browser's
 * account snapshot.
 */
export function isAuraPunkCloudUrl(url: string): boolean {
  return url.replace(/\/+$/, '').endsWith('/api/memory/v1');
}

/** The hosting mode is decided by the persisted URL, not by the account. */
export function resolveHostingMode(url: string): MemoryHostingMode {
  return isAuraPunkCloudUrl(url) ? 'cloud' : 'self-hosted';
}

/**
 * Editable value for the self-managed Mem0 server field. A self-managed source
 * stores its own URL, so show it instead of the Cloud gateway placeholder.
 */
export function resolveSelfManagedUrl(connection: Mem0Connection): string {
  return connection.source === 'cloud' && !isAuraPunkCloudUrl(connection.url)
    ? connection.url
    : connection.cloud_url;
}

export function validateSelfManagedMem0Url(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'Self-managed Mem0 URL must start with http:// or https://';
  }
  return null;
}

export function normalizeEmbeddingDimensions(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EMBEDDING_DIMENSIONS;
  }
  return Math.min(8192, Math.round(parsed));
}

/**
 * Provider patch for `POST /api/usage/mem0-config`: url and model always, the
 * key only when the user typed a new one — the server keeps the existing masked
 * key otherwise. Unknown providers are dropped, and `jev` is taken from the
 * shared Jev credential so both surfaces show the same key.
 */
export function buildProviderPatches(
  drafts: Record<string, ProviderDraft>,
  jev: ProviderDraft
): Record<string, { url: string; model: string; key?: string }> {
  const patches: Record<string, { url: string; model: string; key?: string }> =
    {};
  for (const provider of PROVIDER_ORDER) {
    const draft =
      provider === 'jev' ? jev : (drafts[provider] ?? EMPTY_PROVIDER_DRAFT);
    const patch: { url: string; model: string; key?: string } = {
      url: draft.url,
      model: draft.model,
    };
    if (draft.key) patch.key = draft.key;
    patches[provider] = patch;
  }
  return patches;
}

/**
 * The provider/credentials block of the mem0 container is only written for the
 * self-hosted adapter with memory enabled; the platform manages extraction.
 */
export function shouldPersistMem0Config(input: {
  enabled: boolean;
  adapter: Mem0Adapter;
}): boolean {
  return input.enabled && input.adapter === 'mem0_vk';
}

export function canRunMigration(input: {
  userId: string;
  busy: boolean;
}): boolean {
  return !input.busy && input.userId.trim().length > 0;
}

export function canExecuteMigration(input: {
  userId: string;
  busy: boolean;
  confirm: boolean;
}): boolean {
  return input.confirm && canRunMigration(input);
}

export interface MigrationSide {
  adapter: MigrationAdapter;
  url: string;
  api_key: string;
}

export function buildMigrationRequest(input: {
  source: MigrationSide;
  destination: MigrationSide;
  userId: string;
  mode: 'preview' | 'execute';
  confirm: boolean;
}): {
  source: MigrationSide;
  destination: MigrationSide;
  user_id: string;
  mode: 'preview' | 'execute';
  confirm: boolean;
} {
  return {
    source: input.source,
    destination: input.destination,
    user_id: input.userId.trim(),
    mode: input.mode,
    confirm: input.mode === 'execute' && input.confirm,
  };
}
