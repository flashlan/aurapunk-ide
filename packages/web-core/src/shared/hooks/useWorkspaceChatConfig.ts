import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type WorkspaceChatConfig } from '@/shared/lib/api';

export function useWorkspaceChatConfig(workspaceId: string | undefined) {
  return useQuery<WorkspaceChatConfig | null>({
    queryKey: ['workspace-chat-config', workspaceId],
    queryFn: () =>
      workspaceId ? workspacesApi.getWorkspaceChatConfig(workspaceId) : null,
    enabled: !!workspaceId,
    staleTime: 30 * 1000,
  });
}
