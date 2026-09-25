// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Mock the websocket stream so we can count how many times the chat would
// re-stream when a workspace is (re)mounted. A real stream call == a "reload"
// of the conversation; the cache's whole point is to avoid it on revisit.
vi.mock('@/shared/lib/streamJsonPatchEntries', () => ({
  streamJsonPatchEntries: vi.fn(),
}));

import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';

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

  it('streams once on first (cache-miss) mount', async () => {
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
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does NOT stream on revisit when the finished process is cached', async () => {
    const process = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();

    // Simulate a previous visit that already loaded + cached the entries.
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);
    // Reset the mock call counter AFTER seeding the cache (setCachedEntries
    // doesn't touch the stream), so we measure only this mount's streams.
    vi.mocked(streamJsonPatchEntries).mockClear();

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
    // The key assertion: no websocket stream is opened for the cached process.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);
    unmount();
  });

  it('renders cached history before the live process snapshot arrives', async () => {
    const process = makeFinishedProcess(PROCESS_ID);
    const onTimelineUpdated = vi.fn();

    setCachedExecutionProcesses('ws-1', [process]);
    setCachedEntries(PROCESS_ID, [cachedEntry(PROCESS_ID)]);
    vi.mocked(streamJsonPatchEntries).mockClear();

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
    unmount();
  });

  it('streams again when switching to a workspace with a brand-new process', async () => {
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
    // keyed remount) that contains a brand-new, uncached process -> must stream.
    vi.mocked(streamJsonPatchEntries).mockClear();
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
    // The new process is not cached, so exactly one stream is opened for it.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1);
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
    // On mount, the finished history came from cache -> no stream.
    expect(streamJsonPatchEntries).toHaveBeenCalledTimes(0);

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

  it('finishes the history walk when isLoading flips mid-load on a cached revisit', async () => {
    const slow = makeFinishedProcess('proc-slow');
    const cached = makeFinishedProcess('proc-cached');

    setCachedExecutionProcesses('ws-1', [slow, cached]);
    // 11 entries > MIN_INITIAL_ENTRIES (10): the initial paint stops after the
    // cached process, leaving the UNCACHED slow process for the background
    // batch — that batch blocks on its stream, which is exactly where the
    // isLoading true -> false flip must land.
    setCachedEntries(
      'proc-cached',
      Array.from({ length: 11 }, (_, i) => ({
        ...cachedEntry('proc-cached'),
        patchKey: `proc-cached:${i}`,
      }))
    );

    // The slow process's stream stays pending until the test resolves it;
    // every other stream finishes immediately like the default mock.
    const pendingStreams: Array<{
      onFinished?: (entries: unknown[]) => void;
    }> = [];
    vi.mocked(streamJsonPatchEntries).mockImplementation(
      (url: string, opts: { onFinished?: (entries: unknown[]) => void }) => {
        if (url.includes('proc-slow')) {
          pendingStreams.push(opts);
          return { close: () => {} };
        }
        const controller = { close: () => {} };
        const sampleEntry = {
          type: 'NORMALIZED_ENTRY',
          content: { entry_type: { type: 'user_message' }, content: 'x' },
        };
        Promise.resolve().then(() => opts.onFinished?.([sampleEntry]));
        return controller;
      }
    );

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

    // The background batch is now blocked on proc-slow's stream.
    await waitFor(() =>
      expect(streamJsonPatchEntries).toHaveBeenCalledTimes(1)
    );
    await waitFor(() => expect(result.current.isLoadingHistory).toBe(true));

    // The live process snapshot arrives mid-walk (isLoading true -> false).
    // This effect-dependency churn must NOT abort the walk.
    context = makeContextList([slow, cached]);
    await act(async () => {
      rerender();
    });

    // The blocked stream completes; the walk must finish, emit the historic
    // batch, and clear isLoadingHistory (it used to strand at true forever).
    await act(async () => {
      for (const opts of pendingStreams) {
        opts.onFinished?.([cachedEntry('proc-slow')]);
      }
      pendingStreams.length = 0;
    });

    await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));
    expect(onTimelineUpdated).toHaveBeenCalledWith(
      expect.anything(),
      'historic',
      false
    );
    expect(getCachedEntries('proc-slow')).toBeDefined();
  });
});
