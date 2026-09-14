import { useQuery } from '@tanstack/react-query';
import { handleApiResponse, makeRequest } from '@/shared/lib/api';

export const DEFAULT_AURAPUNK_CLOUD_URL = 'https://aurapunk.dev';
export const AURAPUNK_CLOUD_CONTRACT_VERSION = 1;

export interface AppModeResponse {
  mode: 'local' | 'cloud';
  cloud: boolean;
  cloud_url: string;
  cloud_contract_version: number;
  cloud_contract_path: string;
}

async function fetchAppMode(): Promise<AppModeResponse> {
  const response = await makeRequest('/api/app-mode');
  return handleApiResponse<AppModeResponse>(response);
}

function useAppMode() {
  return useQuery({
    queryKey: ['app-mode'],
    queryFn: fetchAppMode,
    staleTime: Infinity,
    // The embedded Tauri backend can still be starting when the webview
    // mounts. Keep retrying so a transient startup failure cannot make a
    // cloud launch look like a local launch for the rest of the session.
    retry: 10,
    retryDelay: (attempt) => Math.min(250 * 2 ** attempt, 2000),
    refetchOnWindowFocus: true,
  });
}

/**
 * Read the launch mode from the backend rather than from a build-time flag.
 * This keeps `--cloud` useful for both downloaded binaries and local runs.
 */
export function useIsCloudMode(): boolean {
  const { data } = useAppMode();

  return data?.cloud ?? data?.mode === 'cloud';
}

export function useCloudUrl(): string {
  const { data } = useAppMode();

  return data?.cloud_url ?? DEFAULT_AURAPUNK_CLOUD_URL;
}
