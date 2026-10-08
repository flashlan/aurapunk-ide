import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMPTY_PROVIDER_DRAFT,
  buildMigrationRequest,
  buildProviderPatches,
  canExecuteMigration,
  canRunMigration,
  isAuraPunkCloudUrl,
  normalizeEmbeddingDimensions,
  providerLabel,
  resolveHostingMode,
  resolveSelfManagedUrl,
  shouldPersistMem0Config,
  validateSelfManagedMem0Url,
  type Mem0Connection,
} from './mem0Config';

function connection(overrides: Partial<Mem0Connection> = {}): Mem0Connection {
  return {
    source: 'local',
    url: 'http://localhost:8000',
    local_url: 'http://localhost:8000',
    cloud_url: 'https://aurapunk.dev/api/memory/v1',
    enabled: true,
    adapter: 'mem0_vk',
    mem0_api_key_configured: false,
    qdrant_url: 'http://localhost:6333',
    qdrant_api_key_configured: false,
    embedding_dimensions: 384,
    ...overrides,
  };
}

describe('Mem0 hosting mode', () => {
  it('detects the AuraPunk Cloud gateway from the configured URL', () => {
    expect(isAuraPunkCloudUrl('https://aurapunk.dev/api/memory/v1')).toBe(true);
    expect(isAuraPunkCloudUrl('https://aurapunk.dev/api/memory/v1/')).toBe(
      true
    );
    expect(isAuraPunkCloudUrl('http://localhost:8000')).toBe(false);
    expect(resolveHostingMode('https://aurapunk.dev/api/memory/v1')).toBe(
      'cloud'
    );
    expect(resolveHostingMode('https://mem0.internal')).toBe('self-hosted');
  });

  it('keeps a self-managed URL editable instead of the Cloud placeholder', () => {
    expect(
      resolveSelfManagedUrl(
        connection({ source: 'cloud', url: 'https://mem0.internal' })
      )
    ).toBe('https://mem0.internal');
    // On Cloud, the gateway is not the self-managed value.
    expect(resolveSelfManagedUrl(connection())).toBe(
      'https://aurapunk.dev/api/memory/v1'
    );
    expect(
      resolveSelfManagedUrl(
        connection({
          source: 'cloud',
          url: 'https://aurapunk.dev/api/memory/v1',
        })
      )
    ).toBe('https://aurapunk.dev/api/memory/v1');
  });
});

describe('Self-managed Mem0 URL validation', () => {
  it('accepts http(s) and an empty field, rejects anything else', () => {
    expect(validateSelfManagedMem0Url('http://localhost:8000')).toBeNull();
    expect(validateSelfManagedMem0Url('  https://mem0.internal ')).toBeNull();
    expect(validateSelfManagedMem0Url('')).toBeNull();
    expect(validateSelfManagedMem0Url('mem0.internal')).toContain('http://');
    expect(validateSelfManagedMem0Url('ftp://mem0.internal')).toContain(
      'https://'
    );
  });
});

describe('Embedding dimensions', () => {
  it('falls back to the project default and clamps to the API range', () => {
    expect(normalizeEmbeddingDimensions(768)).toBe(768);
    expect(normalizeEmbeddingDimensions('1024')).toBe(1024);
    expect(normalizeEmbeddingDimensions('')).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(normalizeEmbeddingDimensions(0)).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(normalizeEmbeddingDimensions(-5)).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(normalizeEmbeddingDimensions(99999)).toBe(8192);
    expect(normalizeEmbeddingDimensions('384.4')).toBe(384);
  });
});

describe('Provider patches', () => {
  it('sends url and model always but a key only when one was typed', () => {
    const patches = buildProviderPatches(
      {
        groq: { url: 'https://api.groq.com', model: 'llama3', key: '' },
        laya: { url: '', model: 'laya-system1-v1', key: '' },
      },
      {
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        key: '',
      }
    );

    expect(patches.groq).toEqual({
      url: 'https://api.groq.com',
      model: 'llama3',
    });
    expect('key' in patches.groq).toBe(false);
    expect(patches.jev).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
    });
  });

  it('takes the Jev credential from the shared store, not from the drafts', () => {
    const patches = buildProviderPatches(
      { jev: { url: 'https://stale', model: 'stale', key: 'stale-key' } },
      {
        url: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-latest',
        key: 'shared-key',
      }
    );

    expect(patches.jev).toEqual({
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      key: 'shared-key',
    });
  });

  it('covers every provider in order and ignores unknown drafts', () => {
    const patches = buildProviderPatches(
      {
        mystery: { url: 'https://nope', model: 'x', key: 'k' },
        openai: EMPTY_PROVIDER_DRAFT,
      },
      EMPTY_PROVIDER_DRAFT
    );

    expect(Object.keys(patches)).toEqual([
      'jev',
      'laya',
      'groq',
      'openrouter',
      'llama',
      'openai',
    ]);
    expect(patches.mystery).toBeUndefined();
    expect(patches.openai).toEqual({ url: '', model: '' });
  });
});

describe('Mem0 config persistence gate', () => {
  it('writes providers only for an enabled self-hosted adapter', () => {
    expect(shouldPersistMem0Config({ enabled: true, adapter: 'mem0_vk' })).toBe(
      true
    );
    expect(
      shouldPersistMem0Config({ enabled: false, adapter: 'mem0_vk' })
    ).toBe(false);
    expect(
      shouldPersistMem0Config({ enabled: true, adapter: 'mem0_platform' })
    ).toBe(false);
  });
});

describe('Migration guards', () => {
  it('requires a repository slug before anything runs', () => {
    expect(canRunMigration({ userId: 'repo', busy: false })).toBe(true);
    expect(canRunMigration({ userId: '   ', busy: false })).toBe(false);
    expect(canRunMigration({ userId: 'repo', busy: true })).toBe(false);
  });

  it('requires the reviewed-preview confirmation to execute', () => {
    expect(
      canExecuteMigration({ userId: 'repo', busy: false, confirm: true })
    ).toBe(true);
    expect(
      canExecuteMigration({ userId: 'repo', busy: false, confirm: false })
    ).toBe(false);
    expect(
      canExecuteMigration({ userId: '', busy: false, confirm: true })
    ).toBe(false);
  });

  it('confirms only on execute and trims the slug', () => {
    const sides = {
      source: { adapter: 'mem0_vk', url: 'http://a', api_key: '' },
      destination: { adapter: 'mem0_platform', url: 'https://b', api_key: '' },
    } as const;

    expect(
      buildMigrationRequest({
        ...sides,
        userId: '  repo  ',
        mode: 'execute',
        confirm: false,
      })
    ).toMatchObject({ user_id: 'repo', mode: 'execute', confirm: false });
    expect(
      buildMigrationRequest({
        ...sides,
        userId: 'repo',
        mode: 'execute',
        confirm: true,
      })
    ).toMatchObject({ confirm: true });
    expect(
      buildMigrationRequest({
        ...sides,
        userId: 'repo',
        mode: 'preview',
        confirm: true,
      })
    ).toMatchObject({ mode: 'preview', confirm: false });
  });
});

describe('Provider labels', () => {
  it('describes each known provider and passes unknown ones through', () => {
    expect(providerLabel('jev')).toContain('Fast Jev');
    expect(providerLabel('laya')).toContain('Laya');
    expect(providerLabel('mystery')).toBe('mystery');
  });
});
