/**
 * Network access for the Mem0 add-on panel. Every call targets an existing
 * usage route; the pure decision logic lives in `mem0Config.ts`.
 */

import { makeRequest } from '@/shared/lib/remoteApi';
import { handleApiResponse } from '@/shared/lib/api';
import type {
  Mem0Config,
  Mem0Connection,
  MemoryMigrationResult,
  MemorySource,
} from './mem0Config';

export async function fetchMem0Config(): Promise<Mem0Config> {
  const response = await makeRequest('/api/usage/mem0-config', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Config>(response);
}

export async function updateMem0Config(body: {
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

export async function fetchMem0Connection(): Promise<Mem0Connection> {
  const response = await makeRequest('/api/usage/mem0-connection', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<Mem0Connection>(response);
}

export async function updateMem0Connection(
  body: Partial<{
    source: Mem0Connection['source'];
    adapter: Mem0Connection['adapter'];
    enabled: boolean;
    url: string;
    cloud_vector_only: boolean;
    sources: MemorySource[];
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

export async function migrateMemories(body: {
  source: { adapter: string; url: string; api_key: string };
  destination: { adapter: string; url: string; api_key: string };
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

/** The backend redacts secrets: the view only reports whether one is stored. */
export interface RlcdConfigView {
  engine: string;
  laya_url: string | null;
  has_laya_token: boolean;
  jev_url: string | null;
  has_jev_key: boolean;
}

export async function fetchRlcdConfigView(): Promise<RlcdConfigView> {
  const response = await makeRequest('/api/rlcd/config', {
    method: 'GET',
    cache: 'no-store',
  });
  return handleApiResponse<RlcdConfigView>(response);
}
