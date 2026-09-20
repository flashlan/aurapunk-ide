// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ExecutorConfig, TokenUsageInfo } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

// The hook's job is to decide *when* to compact and to call the compactor; the
// compactor itself (classifiers, Jev/Laya HTTP) is not under test here.
const executeSessionCompaction = vi.fn();

vi.mock('../sessionCompactor', () => ({
  executeSessionCompaction: (...args: unknown[]) =>
    executeSessionCompaction(...args),
}));

vi.mock('@/shared/stores/useUiPreferencesStore', () => ({
  useCompactionThreshold: () => '50',
  useCompactorEngine: () => 'laya',
  useLayaMode: () => 'docker',
  useLayaDockerUrl: () => 'http://localhost:8080',
  useLayaCloudUrl: () => 'http://cloud.example/api/memory/v1',
  useJevApiKey: () => '',
  useJevTypesafeUrl: () => 'https://api.typesafe.ai/v1/systemone',
  readCloudAccessToken: () => null,
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

function baseProps(setEntries: (e: PatchTypeWithKey[]) => void) {
  return {
    sessionId: 'session-1',
    tokenUsageInfo,
    executorConfig: {} as unknown as ExecutorConfig,
    isRunning: false,
    entries: entries(4),
    setEntries,
  };
}

describe('useAutoCompaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    executeSessionCompaction.mockReset();
    executeSessionCompaction.mockResolvedValue({
      markerPatch: {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'marker',
        content: {},
      },
      summary: 'compacted',
      tokensBefore: 600,
      tokensAfter: 300,
      reductionRatio: 0.5,
      providerUsed: 'laya',
    });
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

    expect(executeSessionCompaction).toHaveBeenCalledTimes(1);
    expect(setEntries).toHaveBeenCalledTimes(1);
    expect(setEntries.mock.calls[0][0]).toHaveLength(8);
  });

  it('does not compact while the agent is running', async () => {
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction({ ...baseProps(setEntries), isRunning: true })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(executeSessionCompaction).not.toHaveBeenCalled();
  });

  it('stays below the threshold without compacting', async () => {
    const setEntries = vi.fn();
    renderHook(() =>
      useAutoCompaction({
        ...baseProps(setEntries),
        tokenUsageInfo: {
          total_tokens: 300,
          model_context_window: 1000,
        } as unknown as TokenUsageInfo,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(executeSessionCompaction).not.toHaveBeenCalled();
  });
});
