// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ExecutionProcessStatus } from 'shared/types';
import { ExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useConversationHistory } from './useConversationHistory';
import {
  getCachedEntries,
  setCachedExecutionProcesses,
  setCachedEntries,
  clearConversationEntryCache,
} from '../conversationEntryCache';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

// A finished process that still has an in-memory log (the reload-after-finish
// path) is streamed over a websocket; everything else is read as a windowed
// HTTP fetch. Count both: together they are "the conversation had to be read",
// which is exactly what the cache is supposed to avoid on revisit.
vi.mock('@/shared/lib/streamJsonPatchEntries', () => ({
  streamJsonPatchEntries: vi.fn(),
}));

import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';

type WindowOverrides = {
  total?: number;
  fromIndex?: number;
  /** Override for the server's "older window" pointer. */
  nextFromIndex?: number | null;
};

/** Build the `GET /api/execution-processes/{id}/entries` response body. */
function windowResponse(entryCount: number, overrides: WindowOverrides = {}) {
  const total = overrides.total ?? entryCount;
  const fromIndex = overrides.fromIndex ?? 0;
  const endIndex = Math.min(fromIndex + entryCount, total);
  const entries = Array.from(
    { length: Math.max(0, endIndex - fromIndex) },
    (_, offset) => {
      const index = fromIndex + offset;
      return {
        index,
        value: {
          type: 'NORMALIZED_ENTRY',
          content: {
            entry_type: { type: 'user_message' },
            content: `msg-${index}`,
          },
        },
      };
    }
  );

  const nextFromIndex =
    overrides.nextFromIndex !== undefined
      ? overrides.nextFromIndex
      : fromIndex > 0
        ? fromIndex - 200
        : null;

  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        entries,
        from_index: fromIndex,
        end_index: endIndex,
        total_entries: total,
        next_from_index: nextFromIndex,
      },
    }),
  };
}

const fetchMock = vi.fn(async (_input: RequestInfo | URL) => windowResponse(1));

function makeFinishedProcess(id: string) {
  return {
    id,
    workspace_id: 'ws-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    status: 'completed' as ExecutionProcessStatus,
    run_reason: 'codingagent',
    executor_action: {
      typ: { type: 'CodingAgentInitialRequest' },
    },
  } as unknown as import('shared/types').ExecutionProcess;
}

function cachedEntry(processId: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type: { type: 'user_message' },
      content: 'cached message',
    },
    patchKey: `${processId}:0`,
    executionProcessId: processId,
  };
}

function makeContext(process: import('shared/types').ExecutionProcess) {
  return makeContextList([process]);
}

function makeRunningProcess(id: string) {
  return {
    id,
    workspace_id: 'ws-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    status: 'running' as ExecutionProcessStatus,
    run_reason: 'codingagent',
    executor_action: {
      typ: { type: 'CodingAgentFollowUpRequest' },
    },
  } as unknown as import('shared/types').ExecutionProcess;
}

function makeContextList(processes: import('shared/types').ExecutionProcess[]) {
  const byId = Object.fromEntries(processes.map((p) => [p.id, p]));
  return {
    executionProcessesAll: processes,
    executionProcessesByIdAll: byId,
    isAttemptRunningAll: processes.some((p) => p.status === 'running'),
    executionProcessesVisible: processes,
    executionProcessesByIdVisible: byId,
    isAttemptRunningVisible: processes.some((p) => p.status === 'running'),
    isLoading: false,
    isConnected: true,
    error: null,
  } as unknown as import('@/shared/hooks/useExecutionProcessesContext').ExecutionProcessesContextType;
}

function makeLoadingContext() {
  return {
    ...makeContextList([]),
    isLoading: true,
    isConnected: false,
  } as unknown as import('@/shared/hooks/useExecutionProcessesContext').ExecutionProcessesContextType;
}

const PROCESS_ID = 'proc-cache';

describe('useConversationHistory — conversation cache skips re-stream', () => {
  beforeEach(() => {
    clearConversationEntryCache();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    // Default mock: simulate a stream that finishes with one entry. Deferred
    // to a microtask so it mirrors a real async websocket (the source reads
    // `controller` after the call returns, which would be a TDZ error if the
    // callback fired synchronously). A non-empty result matters: the
    // reload-after-finish effect only caches logs when entries.length > 0
    // (a finished process always has output in production).
    vi.mocked(streamJsonPatchEntries).mockImplementation(
      (
        _url: string,
        opts: {
          onEntries?: (e: unknown[]) => void;
          onFinished?: (e: unknown[]) => void;
        }
      ) => {
        const controller = { close: () => {} };
        const sampleEntry = {
          type: 'NORMALIZED_ENTRY',
          content: { entry_type: { type: 'user_message' }, content: 'x' },
        };
        Promise.resolve().then(() => opts.onFinished?.([sampleEntry]));
        return controller;
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads one transcript window on first (cache-miss) mount', async () => {
    const process = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();

    const { unmount } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      {
        wrapper: ({ children }) => (
          <ExecutionProcessesContext.Provider value={makeContext(process)}>
            {children}
          </ExecutionProcessesContext.Provider>
        ),
      }
    );

    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    // One windowed read, no websocket: the whole history is never pulled in.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamJsonPatchEntries).not.toHaveBeenCalled();
    unmount();
  });

  it('does NOT read anything on revisit when the finished process is cached', async () => {
    const process = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();

    // Simulate a previous visit that already loaded + cached the entries.
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);
    // Reset the call counters AFTER seeding the cache (setCachedEntries
    // doesn't touch either transport), so we measure only this mount.
    vi.mocked(streamJsonPatchEntries).mockClear();
    fetchMock.mockClear();

    const { unmount } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      {
        wrapper: ({ children }) => (
          <ExecutionProcessesContext.Provider value={makeContext(process)}>
            {children}
          </ExecutionProcessesContext.Provider>
        ),
      }
    );

    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    // The key assertion: a cached process costs neither a stream nor a fetch.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    unmount();
  });

  it('renders cached history before the live process snapshot arrives', async () => {
    const process = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();

    setCachedExecutionProcesses('ws-1', [process]);
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);
    vi.mocked(streamJsonPatchEntries).mockClear();
    fetchMock.mockClear();

    const { unmount } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      {
        wrapper: ({ children }) => (
          <ExecutionProcessesContext.Provider value={makeLoadingContext()}>
            {children}
          </ExecutionProcessesContext.Provider>
        ),
      }
    );

    await waitFor(() => {
      expect(onTimelineUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          executionProcessState: expect.objectContaining({
            [PROCESS_ID]: expect.objectContaining({
              entries: [cachedEntry(PROCESS_ID)],
            }),
          }),
        }),
        'initial',
        false
      );
    });
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    unmount();
  });

  it('reads a window when switching to a workspace with a brand-new process', async () => {
    const cached = makeFinishedProcess(PROCESS_ID);
    const fresh = makeFinishedProcess('proc-new');
    const onTimelineUpdated = vi.fn();

    // First workspace visit caches its (only) process.
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);

    // Visit workspace 1: its process is cached -> no stream.
    const { unmount } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      {
        wrapper: ({ children }) => (
          <ExecutionProcessesContext.Provider value={makeContext(cached)}>
            {children}
          </ExecutionProcessesContext.Provider>
        ),
      }
    );
    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    unmount();

    // Switch to a DIFFERENT workspace (fresh mount, as the real UI does via its
    // keyed remount) that contains a brand-new, uncached process -> must read it.
    vi.mocked(streamJsonPatchEntries).mockClear();
    fetchMock.mockClear();
    const { unmount: unmount2 } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-2' }),
      {
        wrapper: ({ children }) => (
          <ExecutionProcessesContext.Provider value={makeContext(fresh)}>
            {children}
          </ExecutionProcessesContext.Provider>
        ),
      }
    );
    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    // The new process is not cached, so exactly one window is read for it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamJsonPatchEntries).not.toHaveBeenCalled();
    unmount2();
  });

  it('sending a follow-up streams the new process live (history not re-streamed, final logs cached)', async () => {
    const initial = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();
    // Initial workspace already loaded + cached its finished history.
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);

    let active = [initial];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExecutionProcessesContext.Provider value={makeContextList(active)}>
        {children}
      </ExecutionProcessesContext.Provider>
    );

    const { rerender } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      { wrapper }
    );
    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    // On mount, the finished history came from cache -> no stream, no fetch.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    // Send a follow-up: a brand-new RUNNING process appears. This must stream
    // live (the model "updating"), and the cached finished history must NOT be
    // re-streamed.
    vi.mocked(streamJsonPatchEntries).mockClear();
    const followUp = makeRunningProcess('proc-followup');
    active = [initial, followUp];
    await act(async () => {
      rerender();
    });
    await waitFor(() =>
      expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1)
    );
    // Exactly one stream: the live follow-up. The finished process is untouched.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);

    // The follow-up finishes -> reload effect caches its final logs for next time.
    active = [
      initial,
      { ...followUp, status: 'completed' as ExecutionProcessStatus },
    ];
    await act(async () => {
      rerender();
    });
    await waitFor(() =>
      expect(streamJsonPatchEntries).toHaveBeenCalledTimes(2)
    );
    // Live stream (1) + final-reload stream (1) = 2; history still not re-streamed.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(2);
    expect(getCachedEntries('proc-followup')).toBeDefined();
  });

  it('finishes an on-demand older batch when isLoading flips mid-load', async () => {
    const slow = makeFinishedProcess('proc-slow');
    const cached = makeFinishedProcess('proc-cached');

    setCachedExecutionProcesses('ws-1', [slow, cached]);
    // 11 entries > MIN_INITIAL_ENTRIES (10): the initial paint stops after the
    // cached process, leaving the UNCACHED slow process for the on-demand
    // older batch — that batch blocks on its window read, which is exactly
    // where the isLoading true -> false flip must land.
    setCachedEntries(
      'proc-cached',
      Array.from({ length: 11 }, (_, i) => ({
        ...cachedEntry('proc-cached'),
        patchKey: `proc-cached:${i}`,
      }))
    );

    // The slow process's window stays pending until the test resolves it;
    // every other read resolves immediately like the default mock.
    let resolveSlow:
      | ((value: ReturnType<typeof windowResponse>) => void)
      | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('proc-slow')) {
        return new Promise<ReturnType<typeof windowResponse>>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(windowResponse(1));
    });

    const onTimelineUpdated = vi.fn();
    let context = makeLoadingContext();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExecutionProcessesContext.Provider value={context}>
        {children}
      </ExecutionProcessesContext.Provider>
    );

    const { result, rerender } = renderHook(
      () => useConversationHistory({ onTimelineUpdated, scopeKey: 'ws-1' }),
      { wrapper }
    );

    // Initial budgeted paint comes from cache; NO stream and NO walk yet.
    await waitFor(() => expect(onTimelineUpdated).toHaveBeenCalled());
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(result.current.hasMoreHistory).toBe(true));
    expect(result.current.isLoadingHistory).toBe(false);

    // The reader reaches the top: one older batch is requested and now blocks
    // on proc-slow's window read.
    let batch: Promise<boolean> | undefined;
    await act(async () => {
      batch = result.current.loadOlderBatch();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isLoadingHistory).toBe(true));

    // The live process snapshot arrives mid-batch (isLoading true -> false).
    // This effect-dependency churn must NOT abort the batch.
    context = makeContextList([slow, cached]);
    await act(async () => {
      rerender();
    });

    // The blocked read completes; the batch must finish, emit the historic
    // entries, and clear isLoadingHistory (it used to strand at true forever).
    await act(async () => {
      resolveSlow?.(windowResponse(1));
    });

    await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
    expect(batch).toBeDefined();
    expect(await batch).toBe(false);
    expect(onTimelineUpdated).toHaveBeenCalledWith(
      expect.anything(),
      'historic',
      false
    );

    expect(getCachedEntries('proc-slow')).toBeDefined();
    expect(result.current.hasMoreHistory).toBe(false);
  });
});
