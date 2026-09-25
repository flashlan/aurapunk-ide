import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useProjectTasks } from '@/shared/hooks/useProjectTasks';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';
import {
  isTasksSectionOpen,
  readSidebarTreeOpenState,
  readSidebarTreeOpenStateRaw,
  subscribeSidebarTreeOpenState,
} from '@vibe/ui/components/outliner/openState';

interface SidebarProjectTasksRegistryProps {
  projectIds: readonly string[];
  /** Project whose board is on screen — always loaded so the tree can reveal
   *  the selected card without waiting on a section toggle. */
  activeProjectId: string | null;
  onTasksByProject: (map: ReadonlyMap<string, ProjectTasksData>) => void;
  onLoadingTasksProjectIds: (set: ReadonlySet<string>) => void;
}

/**
 * Rules-of-hooks-safe registry for per-project task loaders.
 *
 * On-demand gate (2026-09-24): a loader is `enabled` only while its project's
 * Tasks section is expanded in the outliner, or while that project is the one
 * on screen. Boot no longer opens one issues/status stream per live project;
 * disabling a loader also drops its refcount so TanStack GCs the collection
 * and its 30 s poll stops. Already-reported data stays in the registry map, so
 * a collapsed section keeps its last-known count instead of flashing to zero.
 *
 * (Supersedes the 2026-08-07 collapse-by-default decision that loaded every
 * project eagerly just to paint the collapsed-section badges — the badge cost
 * more in RAM/network than it was worth. Counts now fill in on first open and
 * persist afterwards.)
 */
export function SidebarProjectTasksRegistry({
  projectIds,
  activeProjectId,
  onTasksByProject,
  onLoadingTasksProjectIds,
}: SidebarProjectTasksRegistryProps) {
  const [isReady, setIsReady] = useState(false);
  const [dataMap, setDataMap] = useState<Map<string, ProjectTasksData>>(
    () => new Map()
  );
  const [loadingSet, setLoadingSet] = useState<Set<string>>(() => new Set());

  // Raw blob as the external-store snapshot: stable string identity, so
  // `useSyncExternalStore` only re-renders when a section is actually
  // toggled (write path or cross-tab `storage` event).
  const openStateRaw = useSyncExternalStore(
    subscribeSidebarTreeOpenState,
    readSidebarTreeOpenStateRaw,
    () => ''
  );

  const enabledProjectIds = useMemo(() => {
    void openStateRaw; // re-derive on every persisted toggle
    const stored = readSidebarTreeOpenState();
    const out = new Set<string>();
    for (const projectId of projectIds) {
      if (
        projectId === activeProjectId ||
        isTasksSectionOpen(stored, projectId)
      ) {
        out.add(projectId);
      }
    }
    return out;
  }, [projectIds, activeProjectId, openStateRaw]);

  const reportData = useCallback((id: string, data: ProjectTasksData) => {
    setDataMap((previous) => {
      const next = new Map(previous);
      next.set(id, data);
      return next;
    });
  }, []);

  const reportLoading = useCallback((id: string, isLoading: boolean) => {
    setLoadingSet((previous) => {
      const hasProject = previous.has(id);
      if (isLoading === hasProject) return previous;

      const next = new Set(previous);
      if (isLoading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Task counts are secondary sidebar decoration. Let the shell and the
  // active Kanban paint first instead of starting one issues/status stream per
  // project during the critical reload path.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const frameId = requestAnimationFrame(() => {
      timeoutId = setTimeout(() => setIsReady(true), 250);
    });

    return () => {
      cancelAnimationFrame(frameId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, []);

  // Drop entries for projects that no longer exist (deleted/removed) so the
  // registry doesn't leak stale data across a long-lived session.
  useEffect(() => {
    const live = new Set(projectIds);
    setDataMap((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const id of next.keys()) {
        if (!live.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setLoadingSet((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const id of previous) {
        if (!live.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [projectIds]);

  useEffect(() => {
    onTasksByProject(dataMap);
  }, [dataMap, onTasksByProject]);

  useEffect(() => {
    onLoadingTasksProjectIds(loadingSet);
  }, [loadingSet, onLoadingTasksProjectIds]);

  return (
    <>
      {isReady &&
        projectIds.map((projectId) => (
          <ProjectTasksLoader
            key={projectId}
            projectId={projectId}
            enabled={enabledProjectIds.has(projectId)}
            onData={reportData}
            onLoading={reportLoading}
          />
        ))}
    </>
  );
}

interface ProjectTasksLoaderProps {
  projectId: string;
  enabled: boolean;
  onData: (id: string, data: ProjectTasksData) => void;
  onLoading: (id: string, isLoading: boolean) => void;
}

function ProjectTasksLoader({
  projectId,
  enabled,
  onData,
  onLoading,
}: ProjectTasksLoaderProps) {
  const { statuses, issues, isLoading } = useProjectTasks(projectId, enabled);

  // Report only while enabled: a disabled loader sees empty arrays from
  // `useShape`, and writing those over the registry would blank the counts and
  // the tree nodes a collapsed section still needs when it re-opens.
  useEffect(() => {
    if (enabled) onData(projectId, { statuses, issues });
  }, [enabled, projectId, statuses, issues, onData]);

  useEffect(() => {
    onLoading(projectId, isLoading);
  }, [projectId, isLoading, onLoading]);

  return null;
}
