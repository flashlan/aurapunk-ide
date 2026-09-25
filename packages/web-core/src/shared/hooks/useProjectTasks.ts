import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  PROJECT_ISSUES_MINIMAL_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
} from 'shared/remote-types';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';

export interface ProjectTasksResult extends ProjectTasksData {
  isLoading: boolean;
}

/**
 * Subscribe lazily to one project's statuses and issues.
 *
 * Issues use the `?minimal=1` projection (`PROJECT_ISSUES_MINIMAL_SHAPE`):
 * the sidebar tree only needs ids, titles, priority and ordering, so the
 * two free-text columns that dominate an issue row's size never leave the
 * server. `minimal` is part of the request params, which also keeps this
 * collection's cache/poll keyed separately from the full board shape.
 */
export function useProjectTasks(
  projectId: string,
  enabled: boolean
): ProjectTasksResult {
  const statusParams = useMemo(() => ({ project_id: projectId }), [projectId]);
  const issueParams = useMemo(
    () => ({ project_id: projectId, minimal: '1' }),
    [projectId]
  );
  const statuses = useShape(PROJECT_PROJECT_STATUSES_SHAPE, statusParams, {
    enabled,
  });
  const issues = useShape(PROJECT_ISSUES_MINIMAL_SHAPE, issueParams, {
    enabled,
  });

  return {
    statuses: statuses.data,
    issues: issues.data,
    isLoading: enabled && (statuses.isLoading || issues.isLoading),
  };
}
