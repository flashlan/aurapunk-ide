// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExecutorConfig, TokenUsageInfo } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

// The hook's job is to decide *when* to compact: it asks the agent to
// `/compact` (the only compaction that shrinks its context) and records a
// marker in the chat.
const requestAgentCompaction = vi.fn(async () => true);

vi.mock('@/shared/stores/useUiPreferencesStore', () => ({
  useCompactionThreshold: () => '50',
  useCompactorEngine: () => 'laya',
}));

vi.mock('@/shared/lib/integrationErrors', () => ({
  reportIntegrationError: vi.fn(),
}));

import { useAutoCompaction } from './useAutoCompaction';

function entries(count: number): PatchTypeWithKey[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'NORMALIZED_ENTRY',
    patchKey: `entry-${i}`,
    content: { entry_type: { type: 'assistant_message' }, content: 'x' },
  })) as unknown as PatchTypeWithKey[];
}

const tokenUsageInfo = {
  total_tokens: 600,
  model_context_window: 1000,
} as unknown as TokenUsageInfo;

function baseProps(
  setEntries: (e: PatchTypeWithKey[]) => void,
  sessionId = 'session-1'
) {
  return {
    sessionId,
    tokenUsageInfo,
    executorConfig: {} as unknown as ExecutorConfig,
    isRunning: false,
    entries: entries(4),
    setEntries,
    requestAgentCompaction,
  };
}

describe('useAutoCompaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestAgentCompaction.mockReset();
    requestAgentCompaction.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still compacts when the effect re-runs before the scheduled run fires', async () => {
    const setEntries = vi.fn();
    const { rerender } = renderHook(
      (props: ReturnType<typeof baseProps>) => useAutoCompaction(props),
      { initialProps: baseProps(setEntries) }
    );

    // Streamed patches re-run the effect repeatedly inside the 1.5s window.
    // Before the fix those re-renders cancelled the pending timer while the
    // in-flight latch stayed set, so compaction never ran again.
    rerender({ ...baseProps(setEntries), entries: entries(5) });
    rerender({ ...baseProps(setEntries), entries: entries(6) });
    rerender({ ...baseProps(setEntries), entries: entries(7) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(requestAgentCompaction).toHaveBeenCalledTimes(1);
    expect(setEntries).toHaveBeenCalledTimes(1);
    expect(setEntries.mock.calls[0][0]).toHaveLength(8);
  });

  it('does not compact while the agent is running', async () => {
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction({
        ...baseProps(setEntries, 'session-running'),
        isRunning: true,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(requestAgentCompaction).not.toHaveBeenCalled();
  });

  it('stays below the threshold without compacting', async () => {
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction({
        ...baseProps(setEntries, 'session-low'),
        tokenUsageInfo: {
          total_tokens: 300,
          model_context_window: 1000,
        } as unknown as TokenUsageInfo,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(requestAgentCompaction).not.toHaveBeenCalled();
  });

  it('keeps the cooldown across a re-mount instead of compacting again', async () => {
    const setEntries = vi.fn();
    const props = baseProps(setEntries, 'session-remount');

    const first = renderHook(() => useAutoCompaction(props));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(requestAgentCompaction).toHaveBeenCalledTimes(1);

    // Leaving the chat and coming back used to reset the per-mount cooldown and
    // inject another "context compacted" marker on arrival.
    first.unmount();
    renderHook(() => useAutoCompaction(props));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(requestAgentCompaction).toHaveBeenCalledTimes(1);
  });

  it('records a marker with the context size once the agent got /compact', async () => {
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction(baseProps(setEntries, 'session-agent-compact'))
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(requestAgentCompaction).toHaveBeenCalledTimes(1);
    const marker = setEntries.mock.calls[0][0].at(-1);
    expect(marker.content.entry_type).toMatchObject({
      type: 'compaction_marker',
      previous_tokens: 600,
    });
  });

  it('adds no marker when /compact was not delivered, and re-arms', async () => {
    requestAgentCompaction.mockResolvedValue(false);
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction(baseProps(setEntries, 'session-undelivered'))
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(requestAgentCompaction).toHaveBeenCalledTimes(1);
    expect(setEntries).not.toHaveBeenCalled();
  });
});
