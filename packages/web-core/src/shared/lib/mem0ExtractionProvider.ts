import { makeRequest } from '@/shared/lib/remoteApi';
import { handleApiResponse } from '@/shared/lib/api';

/**
 * Set the mem0-vk extraction provider. The central Jev/Laya engine selector
 * calls this so the memory extraction provider follows the same choice as the
 * compactor and the guardrails (the extraction provider lives on the server).
 */
export async function updateMem0ExtractionProvider(
  provider: 'jev' | 'laya'
): Promise<void> {
  const response = await makeRequest('/api/usage/mem0-config', {
    method: 'POST',
    body: JSON.stringify({ provider }),
    cache: 'no-store',
  });
  await handleApiResponse<unknown>(response);
}
