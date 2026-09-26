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
import {
  CACHEABLE_TRANSCRIPT_ENTRIES,
  FULL_TRANSCRIPT_LIMIT,
  HISTORIC_WINDOW_ENTRIES,
  fetchHistoricWindow,
  onThinkingHydrated,
  toKeyedEntries,
} from '@/features/workspace-chat/model/historicEntries';
import type {
  AddEntryType,
  ConversationTimelineSource,
  ExecutionProcessState,
  ExecutionProcessStateStore,
  PatchTypeWithKey,
  UseConversationHistoryParams,
} from '@/shared/hooks/useConversationHistory/types';

// Result type for the new UI's conversation history hook
export interface UseConversationHistoryResult {
  /** Whether the conversation only has a single coding agent turn (no follow-ups) */
  isFirstTurn: boolean;
  /** Whether an older-history batch is being fetched right now */
  isLoadingHistory: boolean;
  /**
   * Whether older history remains. Drives the scroll-directed loader: the hook
   * paints only the initial budgeted window and waits to be asked.
   */
  hasMoreHistory: boolean;
  /**
   * Fetch the next older window. Resolves `true` when more history may still
   * remain. Safe to call concurrently — a second call while one is in flight
   * is a no-op.
   */
  loadOlderBatch: () => Promise<boolean>;
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

const HISTORIC_STREAM_TIMEOUT_MS = 15_000;
const INITIAL_HISTORY_LOAD_BUDGET_MS = 5_000;

type HistoricEntriesResult = {
  entries: PatchType[];
  complete: boolean;
};

type ConversationStreamController = ReturnType<
  typeof streamJsonPatchEntries<PatchType>
>;
import { MIN_INITIAL_ENTRIES } from '@/shared/hooks/useConversationHistory/constants';

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
  const [hasMoreHistoryState, setHasMoreHistory] = useState(false);
  const hasMoreHistoryRef = useRef(false);
  const olderBatchInFlightRef = useRef(false);
  const setHasMoreHistoryBoth = useCallback((value: boolean) => {
    hasMoreHistoryRef.current = value;
    setHasMoreHistory(value);
  }, []);
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

  /**
   * Read one window of a finished process's transcript.
   *
   * Conversation processes are windowed: the server hands back at most
   * `HISTORIC_WINDOW_ENTRIES` entries and the scroll loader pages upward, so
   * opening a workspace never materializes every entry it ever produced.
   * Script processes (setup/cleanup/archivescript) are the exception — their
   * whole output is rendered as one turn, so truncating it would silently
   * rewrite what the operator sees.
   *
   * `fromIndex` omitted means "the newest window", which is what a first paint
   * wants.
   */
  const loadHistoricWindow = useCallback(
    async (
      executionProcess: ExecutionProcess,
      fromIndex?: number,
      limit?: number
    ): Promise<ExecutionProcessState | null> => {
      const isScript =
        executionProcess.executor_action.typ.type === 'ScriptRequest';

      if (fromIndex === undefined && !isScript) {
        const cached = getCachedEntries(executionProcess.id);
        if (cached) {
          return {
            executionProcess,
            entries: cached,
            startIndex: 0,
            totalEntries: cached.length,
            hasOlder: false,
          };
        }
      }

      try {
        const window = await fetchHistoricWindow({
          processId: executionProcess.id,
          fromIndex: fromIndex ?? (isScript ? 0 : undefined),
          limit:
            limit ??
            (isScript ? FULL_TRANSCRIPT_LIMIT : HISTORIC_WINDOW_ENTRIES),
        });
        const entries = toKeyedEntries(window, executionProcess.id);

        // Only a window that covers the whole transcript and fits the budget
        // is worth pinning: a partial window must never be mistaken for the
        // whole thing on the next visit, and a multi-thousand-entry run has no
        // business living in localStorage.
        if (
          fromIndex === undefined &&
          window.from_index === 0 &&
          window.end_index >= window.total_entries &&
          window.total_entries <= CACHEABLE_TRANSCRIPT_ENTRIES
        ) {
          setCachedEntries(executionProcess.id, entries);
        }

        return {
          executionProcess,
          entries,
          startIndex: window.from_index,
          totalEntries: window.total_entries,
          hasOlder: window.next_from_index !== null,
          thinkingOmitted: window.entries.some(
            (entry) => entry.thinking_omitted
          ),
        };
      } catch (error) {
        console.warn(
          `Failed to read transcript window for ${executionProcess.id}`,
          error
        );
        return null;
      }
    },
    []
  );

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

        // A null window is a cold failure (first-ever open still normalizing
        // server-side). Stop rather than skipping ahead: the retry below picks
        // this process up again once the cache exists.
        const state = await loadHistoricWindow(executionProcess);
        if (!state) break;
        localDisplayedExecutionProcesses[executionProcess.id] = state;

        if (isConversationProcess(executionProcess)) {
          loadedConversationEntries += state.entries.length;
        }

        if (maxEntries != null && loadedConversationEntries > maxEntries) {
          break;
        }
      }

      return localDisplayedExecutionProcesses;
    },
    [executionProcesses, loadHistoricWindow]
  );

  /**
   * One scroll step of history: first extend the newest held window upward
   * (that is the direction the reader is travelling), then pull the next older
   * process they have not reached yet. Resolves `true` when something loaded.
   */
  const loadOlderWindow = useCallback(async (): Promise<boolean> => {
    if (!executionProcesses?.current) return false;
    const displayed = displayedExecutionProcesses.current;

    const held = executionProcesses.current.filter(
      (executionProcess) =>
        executionProcess.status !== ExecutionProcessStatus.running &&
        displayed[executionProcess.id]
    );

    for (const executionProcess of held.reverse()) {
      const state = displayed[executionProcess.id];
      if (!state?.hasOlder) continue;
      const start = state.startIndex ?? 0;
      if (start <= 0) {
        mergeIntoDisplayed((draft) => {
          const target = draft[executionProcess.id];
          if (target) target.hasOlder = false;
        });
        continue;
      }

      // Request exactly the range above the held window: asking for a full
      // window when fewer entries remain would overlap and duplicate rows
      // (and their patch keys).
      const from = Math.max(0, start - HISTORIC_WINDOW_ENTRIES);
      const older = await loadHistoricWindow(
        executionProcess,
        from,
        start - from
      );
      if (!older) return false;

      mergeIntoDisplayed((draft) => {
        const target = draft[executionProcess.id];
        if (!target) return;
        target.entries = [...older.entries, ...target.entries];
        target.startIndex = older.startIndex;
        target.totalEntries = older.totalEntries;
        target.hasOlder = older.hasOlder;
        target.thinkingOmitted =
          Boolean(target.thinkingOmitted) || Boolean(older.thinkingOmitted);
      });
      return true;
    }

    for (const executionProcess of [...executionProcesses.current].reverse()) {
      if (displayed[executionProcess.id]) continue;
      if (executionProcess.status === ExecutionProcessStatus.running) continue;

      const state = await loadHistoricWindow(executionProcess);
      if (!state) return false;
      mergeIntoDisplayed((draft) => {
        draft[executionProcess.id] = state;
      });
      return true;
    }

    return false;
  }, [executionProcesses, loadHistoricWindow]);

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

  /**
   * Older history is still reachable when a held window has entries above it,
   * or when a finished process has not been pulled in at all.
   */
  const hasOlderHistory = useCallback((): boolean => {
    const displayed = displayedExecutionProcesses.current;
    for (const executionProcess of executionProcesses.current ?? []) {
      if (executionProcess.status === ExecutionProcessStatus.running) continue;
      const state = displayed[executionProcess.id];
      if (!state) return true;
      if (state.hasOlder) return true;
    }
    return false;
  }, []);

  // One scroll step of history. The old behaviour walked every remaining
  // process in a background loop right after the initial paint — a cold
  // workspace paid for its ENTIRE transcript (one websocket + normalisation
  // pass per process) whether or not the operator ever scrolled up. The loop
  // is gone; this is the only way older history is fetched now, driven by the
  // reader reaching the top of the list.
  const loadOlderBatch = useCallback(async (): Promise<boolean> => {
    if (olderBatchInFlightRef.current) return hasMoreHistoryRef.current;
    if (!hasMoreHistoryRef.current) return false;

    const token = historyLoadTokenRef.current;
    olderBatchInFlightRef.current = true;
    setIsLoadingHistory(true);
    try {
      const progressed = await loadOlderWindow();
      if (historyLoadTokenRef.current !== token) return false;
      if (progressed) {
        emitEntries(displayedExecutionProcesses.current, 'historic', false);
      }
      const more = hasOlderHistory();
      setHasMoreHistoryBoth(more);
      return more;
    } finally {
      // A batch that outlived its scope must not clear the in-flight flag the
      // replacement walk for the new scope now owns.
      if (historyLoadTokenRef.current === token) {
        olderBatchInFlightRef.current = false;
        setIsLoadingHistory(false);
      }
    }
  }, [loadOlderWindow, emitEntries, hasOlderHistory, setHasMoreHistoryBoth]);

  // Thinking content is withheld by default — it is the single largest part of
  // a reasoning-heavy transcript and most turns are never opened. When the
  // operator expands a collapsed entry the display layer fetches the real
  // content and lands here, so the row re-renders in place without re-reading
  // the window.
  useEffect(() => {
    return onThinkingHydrated((processId, index, content) => {
      const state = displayedExecutionProcesses.current[processId];
      if (!state) return;
      const position = state.entries.findIndex(
        (entry) => entry.patchKey === `${processId}:${index}`
      );
      if (position === -1) return;

      const current = state.entries[position] as PatchTypeWithKey | undefined;
      if (!current || current.type !== 'NORMALIZED_ENTRY') return;

      state.entries[position] = {
        ...current,
        content: { ...current.content, content },
      };
      state.thinkingOmitted = false;
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    });
  }, [emitEntries]);

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
  // The manifest only matters for which processes exist and their status, so
  // persist it when that changes — not on every stream patch (updated_at and
  // friends), since each write is a synchronous localStorage serialization.
  const rawProcessesRef = useRef(executionProcessesRaw);
  rawProcessesRef.current = executionProcessesRaw;
  const rawIdStatusKey = useMemo(
    () => executionProcessesRaw.map((p) => `${p.id}:${p.status}`).join(','),
    [executionProcessesRaw]
  );
  useEffect(() => {
    if (isLoading || !isConnected) return;
    setCachedExecutionProcesses(scopeKey, rawProcessesRef.current);
  }, [scopeKey, rawIdStatusKey, isLoading, isConnected]);

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
    setHasMoreHistoryBoth(false);
    olderBatchInFlightRef.current = false;
    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    initialHistoryLoadInFlightRef.current = false;
    emittedEmptyInitialRef.current = false;
    streamingProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    emitEntries(displayedExecutionProcesses.current, 'initial', true);
  }, [scopeKey, emitEntries, setHasMoreHistoryBoth]);

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

        // Everything older is fetched on demand when the reader reaches the
        // top of the list (`loadOlderBatch`), not walked eagerly here. Only
        // advertise that there IS something older so the scroll handler arms.
        setHasMoreHistoryBoth(hasOlderHistory());
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
    hasOlderHistory,
    emitEntries,
    setHasMoreHistoryBoth,
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
            startIndex: 0,
            totalEntries: entriesWithKey.length,
            hasOlder: false,
          };
        });
        // Cache only a completed, comfortably-sized transcript: a partial
        // snapshot must be retried on the next visit, and a multi-thousand
        // entry run has no business living in localStorage.
        if (
          result.complete &&
          entriesWithKey.length <= CACHEABLE_TRANSCRIPT_ENTRIES
        ) {
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

  return {
    isFirstTurn,
    isLoadingHistory: isLoadingHistoryState,
    hasMoreHistory: hasMoreHistoryState,
    loadOlderBatch,
  };
};
