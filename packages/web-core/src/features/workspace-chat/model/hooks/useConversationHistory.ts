import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';
import {
  getCachedEntries,
  getCachedExecutionProcesses,
  setCachedExecutionProcesses,
  setCachedEntries,
} from '@/features/workspace-chat/model/conversationEntryCache';
import type {
  AddEntryType,
  ConversationTimelineSource,
  ExecutionProcessStateStore,
  UseConversationHistoryParams,
} from '@/shared/hooks/useConversationHistory/types';

// Result type for the new UI's conversation history hook
export interface UseConversationHistoryResult {
  /** Whether the conversation only has a single coding agent turn (no follow-ups) */
  isFirstTurn: boolean;
  /** Whether background batches are still loading older history entries */
  isLoadingHistory: boolean;
}

function isConversationProcess(
  executionProcess: Pick<ExecutionProcess, 'executor_action'>
): boolean {
  const type = executionProcess.executor_action.typ.type;
  return (
    type === 'CodingAgentFollowUpRequest' ||
    type === 'CodingAgentInitialRequest' ||
    type === 'ReviewRequest'
  );
}

function countConversationEntries(
  executionProcessState: ExecutionProcessStateStore
): number {
  return Object.values(executionProcessState).reduce(
    (count, processState) =>
      isConversationProcess(processState.executionProcess)
        ? count + processState.entries.length
        : count,
    0
  );
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const HISTORIC_STREAM_TIMEOUT_MS = 15_000;
const INITIAL_HISTORY_LOAD_BUDGET_MS = 5_000;

type HistoricEntriesResult = {
  entries: PatchType[];
  complete: boolean;
};

type ConversationStreamController = ReturnType<
  typeof streamJsonPatchEntries<PatchType>
>;
import {
  MIN_INITIAL_ENTRIES,
  REMAINING_BATCH_SIZE,
} from '@/shared/hooks/useConversationHistory/constants';

export const useConversationHistory = ({
  onTimelineUpdated,
  scopeKey,
}: UseConversationHistoryParams): UseConversationHistoryResult => {
  const {
    executionProcessesVisible: executionProcessesRaw,
    isLoading,
    isConnected,
  } = useExecutionProcessesContext();
  const cachedExecutionProcesses = useMemo(
    () => getCachedExecutionProcesses(scopeKey),
    [scopeKey]
  );
  const executionProcessesForConversation = useMemo(
    () =>
      isLoading &&
      executionProcessesRaw.length === 0 &&
      cachedExecutionProcesses
        ? cachedExecutionProcesses
        : executionProcessesRaw,
    [cachedExecutionProcesses, executionProcessesRaw, isLoading]
  );
  const executionProcesses = useRef<ExecutionProcess[]>(
    executionProcessesForConversation
  );
  const displayedExecutionProcesses = useRef<ExecutionProcessStateStore>({});
  const loadedInitialEntries = useRef(false);
  const initialHistoryLoadInFlightRef = useRef(false);
  const emittedEmptyInitialRef = useRef(false);
  const streamingProcessIdsRef = useRef<Set<string>>(new Set());
  const onTimelineUpdatedRef = useRef<
    UseConversationHistoryParams['onTimelineUpdated'] | null
  >(null);
  const previousStatusMapRef = useRef<Map<string, ExecutionProcessStatus>>(
    new Map()
  );
  const activeStreamControllersRef = useRef<Set<ConversationStreamController>>(
    new Set()
  );
  const [isLoadingHistoryState, setIsLoadingHistory] = useState(false);
  // Distinguishes "this walk's scope is gone" from "the effect re-ran because
  // a volatile dependency (isLoading) changed". Only a scope change or
  // unmount bumps the token; a same-scope dependency flip must let the walk
  // finish, or isLoadingHistory strands at true, the remaining older batches
  // never load, and the chat looks frozen when scrolling up.
  const historyLoadTokenRef = useRef(0);

  const closeConversationStreams = useCallback(() => {
    for (const controller of activeStreamControllersRef.current) {
      controller.close();
    }
    activeStreamControllersRef.current.clear();
  }, []);

  // A workspace switch must release only the conversation-history streams
  // owned by this panel. It must not stop the execution process on the
  // backend, nor the global activity stream that tracks other agents.
  useEffect(
    () => closeConversationStreams,
    [scopeKey, closeConversationStreams]
  );

  // Derive whether this is the first turn (no follow-up processes exist)
  const isFirstTurn = useMemo(() => {
    const codingAgentProcessCount = executionProcessesForConversation.filter(
      (ep) =>
        ep.executor_action.typ.type === 'CodingAgentInitialRequest' ||
        ep.executor_action.typ.type === 'CodingAgentFollowUpRequest'
    ).length;
    return codingAgentProcessCount <= 1;
  }, [executionProcessesForConversation]);

  const mergeIntoDisplayed = (
    mutator: (state: ExecutionProcessStateStore) => void
  ) => {
    const state = displayedExecutionProcesses.current;
    mutator(state);
  };

  // The hook owns transport, loading, and reconciliation.
  // It emits a source model that later derivation layers can transform further.

  const buildTimelineSource = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore
    ): ConversationTimelineSource => ({
      executionProcessState,
      liveExecutionProcesses: executionProcesses.current,
    }),
    []
  );

  useEffect(() => {
    onTimelineUpdatedRef.current = onTimelineUpdated;
  }, [onTimelineUpdated]);

  // Keep executionProcesses up to date
  useEffect(() => {
    executionProcesses.current = executionProcessesForConversation.filter(
      (ep) =>
        ep.run_reason === 'setupscript' ||
        ep.run_reason === 'cleanupscript' ||
        ep.run_reason === 'archivescript' ||
        ep.run_reason === 'codingagent'
    );
  }, [executionProcessesForConversation]);

  const loadEntriesForHistoricExecutionProcess = useCallback(
    (
      executionProcess: ExecutionProcess,
      timeoutMs = HISTORIC_STREAM_TIMEOUT_MS
    ) => {
      let url = '';
      if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
        url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
      } else {
        url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
      }

      return new Promise<HistoricEntriesResult>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let controller: ConversationStreamController | undefined;

        const finish = (entries: PatchType[], complete: boolean) => {
          if (settled) return;
          settled = true;
          if (timeout !== null) clearTimeout(timeout);
          if (controller) {
            activeStreamControllersRef.current.delete(controller);
            controller.close();
          }
          resolve({ entries, complete });
        };

        controller = streamJsonPatchEntries<PatchType>(url, {
          onFinished: (allEntries) => finish(allEntries, true),
          onClosed: () => finish(controller?.getEntries() ?? [], false),
          onError: (err) => {
            console.warn(
              `Error loading entries for historic execution process ${executionProcess.id}`,
              err
            );
            finish(controller?.getEntries() ?? [], false);
          },
        });
        activeStreamControllersRef.current.add(controller);

        if (settled) {
          controller.close();
        } else {
          timeout = setTimeout(() => {
            console.warn(
              `Timed out loading entries for historic execution process ${executionProcess.id}`
            );
            finish(controller.getEntries(), false);
          }, timeoutMs);
        }
      });
    },
    []
  );

  const patchWithKey = (
    patch: PatchType,
    executionProcessId: string,
    index: number
  ) => {
    return {
      ...patch,
      patchKey: `${executionProcessId}:${index}`,
      executionProcessId,
    };
  };

  const getActiveAgentProcesses = (): ExecutionProcess[] => {
    return (
      executionProcesses?.current.filter(
        (p) =>
          p.status === ExecutionProcessStatus.running &&
          p.run_reason !== 'devserver'
      ) ?? []
    );
  };

  const emitEntries = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore,
      addEntryType: AddEntryType,
      loading: boolean
    ) => {
      const timelineSource = buildTimelineSource(executionProcessState);
      let modifiedAddEntryType = addEntryType;

      const latestEntry = Object.values(executionProcessState)
        .sort(
          (a, b) =>
            new Date(
              a.executionProcess.created_at as unknown as string
            ).getTime() -
            new Date(
              b.executionProcess.created_at as unknown as string
            ).getTime()
        )
        .flatMap((processState) => processState.entries)
        .at(-1);

      if (
        latestEntry?.type === 'NORMALIZED_ENTRY' &&
        latestEntry.content.entry_type.type === 'tool_use' &&
        latestEntry.content.entry_type.tool_name === 'ExitPlanMode'
      ) {
        modifiedAddEntryType = 'plan';
      }

      onTimelineUpdatedRef.current?.(
        timelineSource,
        modifiedAddEntryType,
        loading
      );
    },
    [buildTimelineSource]
  );

  // This emits its own events as they are streamed
  const loadRunningAndEmit = useCallback(
    (executionProcess: ExecutionProcess): Promise<void> => {
      return new Promise((resolve, reject) => {
        let settled = false;
        let url = '';
        if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
          url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
        } else {
          url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
        }
        let controller: ConversationStreamController;
        const finish = (successful: boolean) => {
          if (settled) return;
          settled = true;
          activeStreamControllersRef.current.delete(controller);
          controller.close();
          if (successful) resolve();
          else reject();
        };

        controller = streamJsonPatchEntries<PatchType>(url, {
          onEntries(entries) {
            const patchesWithKey = entries.map((entry, index) =>
              patchWithKey(entry, executionProcess.id, index)
            );
            mergeIntoDisplayed((state) => {
              state[executionProcess.id] = {
                executionProcess,
                entries: patchesWithKey,
              };
            });
            emitEntries(displayedExecutionProcesses.current, 'running', false);
          },
          onFinished: () => {
            emitEntries(displayedExecutionProcesses.current, 'running', false);
            finish(true);
          },
          onError: () => {
            finish(false);
          },
          onClosed: () => {
            finish(true);
          },
        });
        activeStreamControllersRef.current.add(controller);
      });
    },
    [emitEntries]
  );

  // Sometimes it can take a few seconds for the stream to start, wrap the loadRunningAndEmit method
  const loadRunningAndEmitWithBackoff = useCallback(
    async (executionProcess: ExecutionProcess) => {
      for (let i = 0; i < 20; i++) {
        try {
          await loadRunningAndEmit(executionProcess);
          break;
        } catch (_) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    [loadRunningAndEmit]
  );

  const loadHistoricEntries = useCallback(
    async (
      maxEntries?: number,
      maxDurationMs?: number
    ): Promise<ExecutionProcessStateStore> => {
      const localDisplayedExecutionProcesses: ExecutionProcessStateStore = {};
      let loadedConversationEntries = 0;
      const deadline =
        maxDurationMs == null ? null : Date.now() + maxDurationMs;

      if (!executionProcesses?.current) return localDisplayedExecutionProcesses;

      for (const executionProcess of [
        ...executionProcesses.current,
      ].reverse()) {
        if (executionProcess.status === ExecutionProcessStatus.running)
          continue;
        if (deadline !== null && Date.now() >= deadline) break;

        let entriesWithKey = getCachedEntries(executionProcess.id);
        if (!entriesWithKey) {
          const remainingMs =
            deadline === null ? undefined : Math.max(1, deadline - Date.now());
          const result = await loadEntriesForHistoricExecutionProcess(
            executionProcess,
            remainingMs
          );
          // Do not put an incomplete process in the displayed set. The
          // background loader can retry it immediately after the first paint.
          if (!result.complete) break;
          entriesWithKey = result.entries.map((e, idx) =>
            patchWithKey(e, executionProcess.id, idx)
          );
          if (result.complete) {
            setCachedEntries(executionProcess.id, entriesWithKey);
          }
        }

        localDisplayedExecutionProcesses[executionProcess.id] = {
          executionProcess,
          entries: entriesWithKey,
        };

        if (isConversationProcess(executionProcess)) {
          loadedConversationEntries += entriesWithKey.length;
        }

        if (maxEntries != null && loadedConversationEntries > maxEntries) {
          break;
        }
      }

      return localDisplayedExecutionProcesses;
    },
    [executionProcesses, loadEntriesForHistoricExecutionProcess]
  );

  const loadRemainingEntriesInBatches = useCallback(
    async (batchSize: number): Promise<boolean> => {
      if (!executionProcesses?.current) return false;

      let anyUpdated = false;
      let loadedConversationEntries = countConversationEntries(
        displayedExecutionProcesses.current
      );
      for (const executionProcess of [
        ...executionProcesses.current,
      ].reverse()) {
        const current = displayedExecutionProcesses.current;
        if (
          current[executionProcess.id] ||
          executionProcess.status === ExecutionProcessStatus.running
        )
          continue;

        let entriesWithKey = getCachedEntries(executionProcess.id);
        if (!entriesWithKey) {
          const result =
            await loadEntriesForHistoricExecutionProcess(executionProcess);
          entriesWithKey = result.entries.map((e, idx) =>
            patchWithKey(e, executionProcess.id, idx)
          );
          if (result.complete) {
            setCachedEntries(executionProcess.id, entriesWithKey);
          }
        }

        mergeIntoDisplayed((state) => {
          state[executionProcess.id] = {
            executionProcess,
            entries: entriesWithKey,
          };
        });

        if (isConversationProcess(executionProcess)) {
          loadedConversationEntries += entriesWithKey.length;
        }

        if (loadedConversationEntries > batchSize) {
          anyUpdated = true;
          break;
        }
        anyUpdated = true;
      }
      return anyUpdated;
    },
    [executionProcesses, loadEntriesForHistoricExecutionProcess]
  );

  const ensureProcessVisible = useCallback((p: ExecutionProcess) => {
    mergeIntoDisplayed((state) => {
      if (!state[p.id]) {
        state[p.id] = {
          executionProcess: {
            id: p.id,
            created_at: p.created_at,
            updated_at: p.updated_at,
            executor_action: p.executor_action,
          },
          entries: [],
        };
      }
    });
  }, []);

  const idListKey = useMemo(
    () => executionProcessesForConversation.map((p) => p.id).join(','),
    [executionProcessesForConversation]
  );

  const idStatusKey = useMemo(
    () =>
      executionProcessesForConversation
        .map((p) => `${p.id}:${p.status}`)
        .join(','),
    [executionProcessesForConversation]
  );

  // Keep the process manifest alongside the entry cache. This is deliberately
  // keyed by workspace/session scope because process IDs alone do not tell us
  // which conversation should be painted while the live stream is connecting.
  useEffect(() => {
    if (isLoading || !isConnected) return;
    setCachedExecutionProcesses(scopeKey, executionProcessesRaw);
  }, [scopeKey, executionProcessesRaw, isLoading, isConnected]);

  // Clean up entries for processes that have been removed (e.g., after reset)
  useEffect(() => {
    if (isLoading || !isConnected) return;
    const visibleProcessIds = new Set(
      executionProcessesForConversation.map((p) => p.id)
    );
    const displayedIds = Object.keys(displayedExecutionProcesses.current);
    let changed = false;

    for (const id of displayedIds) {
      if (!visibleProcessIds.has(id)) {
        delete displayedExecutionProcesses.current[id];
        changed = true;
      }
    }

    if (changed) {
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    }
  }, [
    idListKey,
    executionProcessesForConversation,
    emitEntries,
    isLoading,
    isConnected,
  ]);

  useEffect(() => {
    historyLoadTokenRef.current += 1;
    setIsLoadingHistory(false);
    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    initialHistoryLoadInFlightRef.current = false;
    emittedEmptyInitialRef.current = false;
    streamingProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    emitEntries(displayedExecutionProcesses.current, 'initial', true);
  }, [scopeKey, emitEntries]);

  // Abort any in-flight history walk after unmount so it neither emits into a
  // dead component nor keeps opening streams.
  useEffect(() => {
    return () => {
      historyLoadTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const token = historyLoadTokenRef.current;
    const isStale = () => historyLoadTokenRef.current !== token;
    (async () => {
      if (loadedInitialEntries.current || initialHistoryLoadInFlightRef.current)
        return;

      // A cached process manifest is enough to paint cached history while the
      // live process WebSocket is still delivering its first snapshot.
      if (isLoading && cachedExecutionProcesses === undefined) return;

      initialHistoryLoadInFlightRef.current = true;
      try {
        if (executionProcesses.current.length === 0) {
          if (emittedEmptyInitialRef.current) return;
          emittedEmptyInitialRef.current = true;
          emitEntries(displayedExecutionProcesses.current, 'initial', false);
          return;
        }

        emittedEmptyInitialRef.current = false;

        const allInitialEntries = await loadHistoricEntries(
          MIN_INITIAL_ENTRIES,
          INITIAL_HISTORY_LOAD_BUDGET_MS
        );
        if (isStale()) return;
        loadedInitialEntries.current = true;
        mergeIntoDisplayed((state) => {
          Object.assign(state, allInitialEntries);
        });
        emitEntries(displayedExecutionProcesses.current, 'initial', false);

        setIsLoadingHistory(true);
        // Let React paint the initial cached batch before walking older history.
        // Without this yield, cache hits resolve as microtasks and a large
        // conversation can starve the browser's next paint.
        await yieldToBrowser();
        while (!isStale()) {
          const hasMore =
            await loadRemainingEntriesInBatches(REMAINING_BATCH_SIZE);
          if (!hasMore) break;
          if (isStale()) return;
          emitEntries(displayedExecutionProcesses.current, 'historic', false);
          await yieldToBrowser();
        }
        if (!isStale()) setIsLoadingHistory(false);
      } finally {
        // A walk that outlived its scope must not clear the in-flight flag a
        // replacement walk for the new scope already owns.
        if (historyLoadTokenRef.current === token) {
          initialHistoryLoadInFlightRef.current = false;
        }
      }
    })();
  }, [
    scopeKey,
    isLoading,
    cachedExecutionProcesses,
    loadHistoricEntries,
    loadRemainingEntriesInBatches,
    emitEntries,
  ]);

  useEffect(() => {
    const activeProcesses = getActiveAgentProcesses();
    if (activeProcesses.length === 0) return;

    for (const activeProcess of activeProcesses) {
      if (!displayedExecutionProcesses.current[activeProcess.id]) {
        const runningOrInitial =
          Object.keys(displayedExecutionProcesses.current).length > 1
            ? 'running'
            : 'initial';
        ensureProcessVisible(activeProcess);
        emitEntries(
          displayedExecutionProcesses.current,
          runningOrInitial,
          false
        );
      }

      if (
        activeProcess.status === ExecutionProcessStatus.running &&
        !streamingProcessIdsRef.current.has(activeProcess.id)
      ) {
        streamingProcessIdsRef.current.add(activeProcess.id);
        loadRunningAndEmitWithBackoff(activeProcess).finally(() => {
          streamingProcessIdsRef.current.delete(activeProcess.id);
        });
      }
    }
  }, [
    scopeKey,
    idStatusKey,
    emitEntries,
    ensureProcessVisible,
    loadRunningAndEmitWithBackoff,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!executionProcessesRaw) return;

    const processesToReload: ExecutionProcess[] = [];

    for (const process of executionProcessesForConversation) {
      const previousStatus = previousStatusMapRef.current.get(process.id);
      const currentStatus = process.status;

      if (
        previousStatus === ExecutionProcessStatus.running &&
        currentStatus !== ExecutionProcessStatus.running &&
        displayedExecutionProcesses.current[process.id]
      ) {
        processesToReload.push(process);
      }

      previousStatusMapRef.current.set(process.id, currentStatus);
    }

    if (processesToReload.length === 0) return;

    (async () => {
      let anyUpdated = false;

      for (const process of processesToReload) {
        if (cancelled) return;
        const result = await loadEntriesForHistoricExecutionProcess(process);
        if (cancelled) return;
        if (result.entries.length === 0) continue;

        const entriesWithKey = result.entries.map((e, idx) =>
          patchWithKey(e, process.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[process.id] = {
            executionProcess: process,
            entries: entriesWithKey,
          };
        });
        // Cache only a completed stream; a timeout/error may contain a partial
        // snapshot and must be retried on the next workspace visit.
        if (result.complete) {
          setCachedEntries(process.id, entriesWithKey);
        }
        anyUpdated = true;
      }

      if (anyUpdated) {
        emitEntries(displayedExecutionProcesses.current, 'running', false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    idStatusKey,
    executionProcessesForConversation,
    emitEntries,
    loadEntriesForHistoricExecutionProcess,
  ]);

  // If an execution process is removed, remove it from the state
  useEffect(() => {
    if (!executionProcessesForConversation) return;

    const removedProcessIds = Object.keys(
      displayedExecutionProcesses.current
    ).filter(
      (id) => !executionProcessesForConversation.some((p) => p.id === id)
    );

    if (removedProcessIds.length > 0) {
      mergeIntoDisplayed((state) => {
        removedProcessIds.forEach((id) => {
          delete state[id];
        });
      });
    }
  }, [scopeKey, idListKey, executionProcessesForConversation]);

  return { isFirstTurn, isLoadingHistory: isLoadingHistoryState };
};
