import { ReactNode, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '@/shared/hooks/useWorkspaces';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { useWorkspaceRecord } from '@/shared/hooks/useWorkspaceRecord';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useWorkspaceSessions } from '@/shared/hooks/useWorkspaceSessions';
import { useGitHubComments } from '@/shared/hooks/useGitHubComments';
import { useDiffStream } from '@/shared/hooks/useDiffStream';
import { ApiError, workspacesApi } from '@/shared/lib/api';
import { useWorkspaceDiffStore } from '@/shared/stores/useWorkspaceDiffStore';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import type { DiffStats } from 'shared/types';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';

import { WorkspaceContext } from '@/shared/hooks/useWorkspaceContext';

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { workspaceId } = useParams({ strict: false });
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const queryClient = useQueryClient();

  const isCreateMode = currentDestination?.kind === 'workspaces-create';

  const {
    workspaces: activeWorkspaces,
    archivedWorkspaces,
    isLoading: isLoadingList,
  } = useWorkspaces();

  const {
    data: workspace,
    isLoading: isLoadingWorkspace,
    error: workspaceError,
  } = useWorkspaceRecord(workspaceId, {
    enabled: !!workspaceId && !isCreateMode,
  });

  const {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading: isSessionsLoading,
    isNewSessionMode,
    startNewSession,
  } = useWorkspaceSessions(workspaceId, { enabled: !isCreateMode });

  const { repos, isLoading: isReposLoading } = useWorkspaceRepo(workspaceId, {
    enabled: !isCreateMode,
  });

  // TODO: Support multiple repos - currently only fetches comments from the primary repo.
  const primaryRepoId = repos[0]?.id;

  const currentWorkspaceSummary = activeWorkspaces.find(
    (w) => w.id === workspaceId
  );
  const hasPrAttached = !!currentWorkspaceSummary?.prStatus;

  const {
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  } = useGitHubComments({
    workspaceId,
    repoId: primaryRepoId,
    enabled: !isCreateMode && hasPrAttached,
  });

  const { diffs } = useDiffStream(workspaceId ?? null, !isCreateMode);

  const diffPaths = useMemo(
    () =>
      new Set(diffs.map((d) => d.newPath || d.oldPath || '').filter(Boolean)),
    [diffs]
  );

  const diffStats: DiffStats = useMemo(
    () => ({
      files_changed: diffs.length,
      lines_added: diffs.reduce((sum, d) => sum + (d.additions ?? 0), 0),
      lines_removed: diffs.reduce((sum, d) => sum + (d.deletions ?? 0), 0),
    }),
    [diffs]
  );

  const rafRef = useRef<number | null>(null);
  const batchCountRef = useRef(0);

  const latestDiffDataRef = useRef({
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  });
  latestDiffDataRef.current = {
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  };

  useEffect(() => {
    batchCountRef.current++;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        batchCountRef.current = 0;
        useWorkspaceDiffStore
          .getState()
          .setWorkspaceDiffData(latestDiffDataRef.current);
      });
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    diffs,
    diffPaths,
    diffStats,
    gitHubComments,
    isGitHubCommentsLoading,
    showGitHubComments,
    setShowGitHubComments,
    getGitHubCommentsForFile,
    getGitHubCommentCountForFile,
    getFilesWithGitHubComments,
    getFirstCommentLineForFile,
  ]);

  useEffect(() => {
    return () => {
      useWorkspaceDiffStore.getState().clearWorkspaceDiffData();
    };
  }, []);

  const isLoading = isLoadingList || isLoadingWorkspace;

  useEffect(() => {
    if (!workspaceId || isCreateMode) return;

    // Persist last visited workspace so the next app launch can restore it
    // ("nao salva o workspace ao sair"). Stored in localStorage via
    // the UiPreferencesStore (client-side only, same pattern as workspaceColors).
    try {
      useUiPreferencesStore.getState().setLastWorkspaceId(workspaceId);
    } catch {
      // store may be unavailable during early render
    }

    workspacesApi
      .markSeen(workspaceId)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      })
      .catch((error) => {
        console.warn('Failed to mark workspace as seen:', error);
      });
  }, [workspaceId, isCreateMode, queryClient]);

  // Extra guarantee on tab close / reload: flush the same key via beforeunload
  // so the last workspace is never lost even if the effect above hasn't fired
  // (e.g. very fast navigation).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      if (!workspaceId || isCreateMode) return;
      try {
        // Direct localStorage write as synchronous fallback; the store write
        // above is async-ish via Zustand.
        window.localStorage.setItem('vk-last-workspace-id', workspaceId);
      } catch {
        // localStorage may be unavailable
      }
    };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, [workspaceId, isCreateMode]);

  // Leave a workspace that no longer exists. Deleting the open workspace (from
  // the sidebar, the board or an agent via MCP) used to strand the view on it:
  // an empty chat, every poll answering 404, and "Failed to send: Not Found"
  // on the next message. Two signals, so a brand-new workspace that has not
  // reached the list stream yet is never mistaken for a deleted one: it was in
  // the live list and vanished, or fetching it directly returned 404 (a stale
  // URL or bookmark).
  const seenInListRef = useRef<string | null>(null);
  const isInList =
    !!workspaceId &&
    (activeWorkspaces.some((w) => w.id === workspaceId) ||
      archivedWorkspaces.some((w) => w.id === workspaceId));
  const recordNotFound =
    workspaceError instanceof ApiError && workspaceError.status === 404;
  useEffect(() => {
    if (!workspaceId || isCreateMode) return;
    if (isInList) {
      seenInListRef.current = workspaceId;
      return;
    }
    const vanished = !isLoadingList && seenInListRef.current === workspaceId;
    if (vanished || recordNotFound) {
      seenInListRef.current = null;
      console.info(
        `[workspace] ${workspaceId} no longer exists; leaving its view`
      );
      appNavigation.goToRoot();
    }
  }, [
    workspaceId,
    isCreateMode,
    isInList,
    isLoadingList,
    recordNotFound,
    appNavigation,
  ]);

  const selectWorkspace = useCallback(
    (id: string) => {
      appNavigation.goToWorkspace(id);
    },
    [appNavigation]
  );

  const navigateToCreate = useMemo(
    () => () => {
      appNavigation.goToWorkspacesCreate();
    },
    [appNavigation]
  );

  const coreValue = useMemo(
    () => ({
      workspaceId,
      workspace,
      activeWorkspaces,
      archivedWorkspaces,
      isWorkspacesListLoading: isLoadingList,
      isLoading,
      isCreateMode,
      selectWorkspace,
      navigateToCreate,
      sessions,
      selectedSession,
      selectedSessionId,
      selectSession,
      selectLatestSession,
      isSessionsLoading,
      isNewSessionMode,
      startNewSession,
      repos,
      isReposLoading,
    }),
    [
      workspaceId,
      workspace,
      activeWorkspaces,
      archivedWorkspaces,
      isLoadingList,
      isLoading,
      isCreateMode,
      selectWorkspace,
      navigateToCreate,
      sessions,
      selectedSession,
      selectedSessionId,
      selectSession,
      selectLatestSession,
      isSessionsLoading,
      isNewSessionMode,
      startNewSession,
      repos,
      isReposLoading,
    ]
  );

  return (
    <WorkspaceContext.Provider value={coreValue}>
      {children}
    </WorkspaceContext.Provider>
  );
}
