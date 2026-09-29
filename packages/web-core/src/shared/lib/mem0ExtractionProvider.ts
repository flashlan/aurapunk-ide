import { makeRequest } from '@/shared/lib/remoteApi';
import { handleApiResponse } from '@/shared/lib/api';

/**
 * Set the mem0-vk extraction provider. The central Jev/Laya engine selector
 * calls this so the memory extraction provider follows the same choice as the
 * compactor and the guardrails (the extraction provider lives on the server).
 *
 * Resolves to the provider the memory server actually uses. A hosted server
 * (AuraPunk Cloud, Mem0 Platform) keeps its own: the Jev key is personal and
 * never leaves this machine, so Jev only runs locally there.
 */
export async function updateMem0ExtractionProvider(
  provider: 'jev' | 'laya'
): Promise<string> {
  const response = await makeRequest('/api/usage/mem0-config', {
    method: 'POST',
    body: JSON.stringify({ provider }),
    cache: 'no-store',
  });
  const config = await handleApiResponse<{ provider: string }>(response);
  return config.provider;
}
