import { useCallback, useMemo } from 'react';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type { ExecutionProcess } from 'shared/types';

type ExecutionProcessState = {
  execution_processes: Record<string, ExecutionProcess>;
};

interface UseExecutionProcessesResult {
  executionProcesses: ExecutionProcess[];
  executionProcessesById: Record<string, ExecutionProcess>;
  isAttemptRunning: boolean;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

/**
 * Stream execution processes for a session via WebSocket (JSON Patch) and expose as array + map.
 * Server sends initial snapshot: replace /execution_processes with an object keyed by id.
 * Live updates arrive at /execution_processes/<id> via add/replace/remove operations.
 */
export const useExecutionProcesses = (
  sessionId: string | undefined,
  opts?: { showSoftDeleted?: boolean }
): UseExecutionProcessesResult => {
  const hostId = useHostId();
  const showSoftDeleted = opts?.showSoftDeleted;
  let endpoint: string | undefined;

  if (sessionId) {
    const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
    const params = new URLSearchParams({ session_id: sessionId });
    if (typeof showSoftDeleted === 'boolean') {
      params.set('show_soft_deleted', String(showSoftDeleted));
    }
    endpoint = `${apiBasePath}/execution-processes/stream/session/ws?${params.toString()}`;
  }

  const initialData = useCallback(
    (): ExecutionProcessState => ({ execution_processes: {} }),
    []
  );

  const { data, isConnected, isInitialized, error } =
    useJsonPatchWsStream<ExecutionProcessState>(
      endpoint,
      !!sessionId,
      initialData
    );

  // `data` is produced by Immer, so its identity only changes when a patch
  // lands. Deriving the arrays inside a memo keeps them referentially stable
  // across unrelated re-renders; otherwise every render handed consumers a new
  // array and re-fired their effects (including a synchronous localStorage
  // write of the whole process list in the conversation cache).
  const processMap = data?.execution_processes;
  const { executionProcesses, executionProcessesById, isAttemptRunning } =
    useMemo(() => {
      const streamed = Object.values(processMap ?? {}).sort(
        (a, b) =>
          new Date(a.created_at as unknown as string).getTime() -
          new Date(b.created_at as unknown as string).getTime()
      );

      // Guard against stale buffered stream data when switching sessions quickly.
      const processes = sessionId
        ? streamed.filter(
            (executionProcess) => executionProcess.session_id === sessionId
          )
        : streamed;

      const byId: Record<string, ExecutionProcess> = {};
      for (const executionProcess of processes) {
        byId[executionProcess.id] = executionProcess;
      }

      const running = processes.some(
        (process) =>
          (process.run_reason === 'codingagent' ||
            process.run_reason === 'setupscript' ||
            process.run_reason === 'cleanupscript' ||
            process.run_reason === 'archivescript') &&
          process.status === 'running'
      );

      return {
        executionProcesses: processes,
        executionProcessesById: byId,
        isAttemptRunning: running,
      };
    }, [processMap, sessionId]);
  const isLoading = !!sessionId && !isInitialized && !error; // until first snapshot

  return {
    executionProcesses,
    executionProcessesById,
    isAttemptRunning,
    isLoading,
    isConnected,
    error,
  };
};
