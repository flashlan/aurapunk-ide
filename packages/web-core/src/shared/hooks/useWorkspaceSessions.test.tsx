// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from 'shared/types';
import { useWorkspaceSessions } from './useWorkspaceSessions';
import { workspaceSessionKeys } from './workspaceSessionKeys';

// The hook only needs `useHostId` from the provider; a hoisted ref lets tests
// flip the host id mid-run to reproduce the query-key change (no-data window)
// that used to wipe the selection.
const hostRef = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('@/shared/providers/HostIdProvider', () => ({
  useHostId: () => hostRef.current,
}));

const getByWorkspaceMock = vi.hoisted(() => vi.fn());
vi.mock('@/shared/lib/api', () => ({
  sessionsApi: { getByWorkspace: getByWorkspaceMock },
}));

function makeSession(id: string): Session {
  return {
    id,
    workspace_id: 'ws-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  } as unknown as Session;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('useWorkspaceSessions — sticky session selection', () => {
  beforeEach(() => {
    hostRef.current = null;
    getByWorkspaceMock.mockReset();
  });

  it('auto-selects the most recently used session once sessions load', async () => {
    getByWorkspaceMock.mockResolvedValue([
      makeSession('s-a'),
      makeSession('s-b'),
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useWorkspaceSessions('ws-1'), {
      wrapper: makeWrapper(client),
    });

    // While the list is still pending the chat must resolve (placeholder),
    // not masquerade as an empty new-session workspace.
    expect(result.current.isNewSessionMode).toBe(false);

    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));
    expect(result.current.isNewSessionMode).toBe(false);
  });

  it('keeps the selection when the list refreshes in a different order', async () => {
    const first = [makeSession('s-a'), makeSession('s-b')];
    getByWorkspaceMock.mockResolvedValue(first);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      () => useWorkspaceSessions('ws-1'),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));

    // A refetch (window focus, session create/rename invalidation) returns
    // the same sessions in a different MRU order — a NEW array identity.
    // The reader must not be hijacked to whichever session is now first.
    act(() => {
      client.setQueryData(workspaceSessionKeys.byWorkspace('ws-1', null), [
        makeSession('s-b'),
        makeSession('s-a'),
      ]);
      rerender();
    });
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));

    // An explicit user switch must also survive subsequent refreshes.
    act(() => result.current.selectSession('s-b'));
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-b'));
    act(() => {
      client.setQueryData(workspaceSessionKeys.byWorkspace('ws-1', null), [
        makeSession('s-a'),
        makeSession('s-b'),
      ]);
      rerender();
    });
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-b'));
  });

  it('holds the selection through a no-data query window (host id change)', async () => {
    getByWorkspaceMock.mockResolvedValue([
      makeSession('s-a'),
      makeSession('s-b'),
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      () => useWorkspaceSessions('ws-1'),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));
    act(() => result.current.selectSession('s-b'));
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-b'));

    // New query key => the fresh query has no data yet. The old code saw an
    // empty list here, cleared the selection (chat blanked and remounted)
    // and then stomped it back to sessions[0] when data returned.
    hostRef.current = 'host-1';
    rerender();
    expect(result.current.selectedSessionId).toBe('s-b');
    expect(result.current.isNewSessionMode).toBe(false);

    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-b'));
  });

  it('clears the selection and falls back to new-session mode when the server has no sessions', async () => {
    getByWorkspaceMock.mockResolvedValue([makeSession('s-a')]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result, rerender } = renderHook(
      () => useWorkspaceSessions('ws-1'),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));

    act(() => {
      client.setQueryData(workspaceSessionKeys.byWorkspace('ws-1', null), []);
      rerender();
    });
    await waitFor(() =>
      expect(result.current.selectedSessionId).toBeUndefined()
    );
    expect(result.current.isNewSessionMode).toBe(true);
  });

  it('keeps new-session mode while the user has explicitly entered it', async () => {
    getByWorkspaceMock.mockResolvedValue([makeSession('s-a')]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useWorkspaceSessions('ws-1'), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.selectedSessionId).toBe('s-a'));

    act(() => result.current.startNewSession());
    expect(result.current.isNewSessionMode).toBe(true);
    expect(result.current.selectedSessionId).toBeUndefined();

    // A list refresh must not yank the user out of new-session mode.
    act(() => {
      client.setQueryData(workspaceSessionKeys.byWorkspace('ws-1', null), [
        makeSession('s-a'),
        makeSession('s-b'),
      ]);
    });
    await waitFor(() => expect(result.current.isNewSessionMode).toBe(true));
  });
});
