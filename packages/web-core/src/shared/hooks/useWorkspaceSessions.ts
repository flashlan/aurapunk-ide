import { useQuery } from '@tanstack/react-query';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { sessionsApi } from '@/shared/lib/api';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import type { Session } from 'shared/types';

interface UseWorkspaceSessionsOptions {
  enabled?: boolean;
}

/** Discriminated union for session selection state */
export type SessionSelection =
  | { mode: 'existing'; sessionId: string }
  | { mode: 'new' };

interface UseWorkspaceSessionsResult {
  sessions: Session[];
  selectedSession: Session | undefined;
  selectedSessionId: string | undefined;
  selectSession: (sessionId: string) => void;
  selectLatestSession: () => void;
  isLoading: boolean;
  /** Whether user is creating a new session */
  isNewSessionMode: boolean;
  /** Enter new session mode */
  startNewSession: () => void;
}

/**
 * Hook for managing sessions within a workspace.
 * Fetches all sessions for a workspace and provides session switching capability.
 * Sessions are ordered by most recently used (latest non-dev server execution first).
 */
export function useWorkspaceSessions(
  workspaceId: string | undefined,
  options: UseWorkspaceSessionsOptions = {}
): UseWorkspaceSessionsResult {
  const hostId = useHostId();
  const { enabled = true } = options;
  const [selection, setSelection] = useState<SessionSelection | undefined>(
    undefined
  );
  const prevWorkspaceIdRef = useRef(workspaceId);

  const {
    data: sessions = [],
    isLoading,
    isPending,
  } = useQuery<Session[]>({
    queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
    queryFn: () => sessionsApi.getByWorkspace(workspaceId!),
    enabled: enabled && !!workspaceId,
  });

  // Combined effect: handle workspace changes and auto-select sessions.
  // Selection is STICKY: query refreshes, most-recently-used reordering, and
  // transient no-data windows (query key changes, enabled toggles) must never
  // clear or hijack a valid selection — every selectedSessionId change
  // remounts the conversation (blank flash + jump to the end) mid-read, which
  // is exactly what made scrolling history unusable. Default to the most
  // recently used session only when nothing valid is selected; the send flow
  // selects newly created sessions explicitly (useSessionSend), so nothing
  // relies on refreshes stomping the selection.
  useEffect(() => {
    const workspaceChanged = prevWorkspaceIdRef.current !== workspaceId;
    prevWorkspaceIdRef.current = workspaceId;

    if (workspaceChanged) {
      // Never leak the previous workspace's session into the new scope.
      setSelection(
        sessions.length > 0
          ? { mode: 'existing', sessionId: sessions[0].id }
          : undefined
      );
      return;
    }

    // No data yet (first load, query key change, disabled query): hold the
    // current selection so the conversation does not blank or remount.
    if (isPending) return;

    if (sessions.length > 0) {
      setSelection((prev) => {
        if (prev?.mode === 'new') return prev;
        if (
          prev?.mode === 'existing' &&
          sessions.some((session) => session.id === prev.sessionId)
        ) {
          return prev;
        }
        return { mode: 'existing', sessionId: sessions[0].id };
      });
    } else {
      // The server reports no sessions at all (all deleted): drop the
      // selection so the workspace falls back to new-session mode.
      setSelection(undefined);
    }
  }, [workspaceId, sessions, isPending]);

  const isNewSessionMode =
    selection?.mode === 'new' || (sessions.length === 0 && !isPending);
  const selectedSessionId =
    selection?.mode === 'existing' ? selection.sessionId : undefined;

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectSession = useCallback((sessionId: string) => {
    setSelection({ mode: 'existing', sessionId });
  }, []);

  const selectLatestSession = useCallback(() => {
    if (sessions.length > 0) {
      setSelection({ mode: 'existing', sessionId: sessions[0].id });
    }
  }, [sessions]);

  const startNewSession = useCallback(() => {
    setSelection({ mode: 'new' });
  }, []);

  return {
    sessions,
    selectedSession,
    selectedSessionId,
    selectSession,
    selectLatestSession,
    isLoading,
    isNewSessionMode,
    startNewSession,
  };
}
