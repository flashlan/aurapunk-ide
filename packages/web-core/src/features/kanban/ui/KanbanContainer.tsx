import {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  type MouseEvent,
  memo,
  Profiler,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useProjects } from '@/shared/hooks/useProjects';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { useActions } from '@/shared/hooks/useActions';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { cn } from '@/shared/lib/utils';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  useUiPreferencesStore,
  resolveKanbanProjectState,
  KANBAN_PROJECT_VIEW_IDS,
  type KanbanFilterState,
  type KanbanSortField,
} from '@/shared/stores/useUiPreferencesStore';
import {
  useKanbanFilters,
  PRIORITY_ORDER,
} from '../model/hooks/useKanbanFilters';
import {
  type BulkUpdateIssueItem,
  bulkUpdateIssues,
  fetchIssueMetrics,
} from '@/shared/lib/remoteApi';
import { persistIssues, persistIssueSwap } from '@/shared/lib/persistIssues';
import {
  ArrowLeftIcon,
  PlusIcon,
  DotsThreeIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { Actions } from '@/shared/actions';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  type ProjectIssueCreateOptions,
  useKanbanIssueComposer,
} from '@/shared/stores/useKanbanIssueComposerStore';
// ADR-019: User entity excised — no UserWithProfile import needed.
import {
  KanbanProvider,
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  type DropResult,
} from '@vibe/ui/components/KanbanBoard';
import { DragDropContext } from '@hello-pangea/dnd';
import { KanbanCardContent } from '@vibe/ui/components/KanbanCardContent';
import { KanbanWorkspaceDispatch } from '@vibe/ui/components/KanbanWorkspaceDispatch';
import { CardInfoDialog } from '@vibe/ui/components/CardInfoDialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  MergeBlockedDialog,
  getDirtyWorktreeBlock,
  getMergeConflictsBlock,
} from './MergeBlockedDialog';
import { useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import {
  IssueWorkspaceCard,
  type WorkspaceWithStats,
  type WorkspacePr,
} from '@vibe/ui/components/IssueWorkspaceCard';
import { resolveRelationshipsForIssue } from '@/shared/lib/resolveRelationships';
import { KanbanFilterBar } from '@vibe/ui/components/KanbanFilterBar';
import { ViewNavTabs } from '@vibe/ui/components/ViewNavTabs';
import { IssueListView } from '@vibe/ui/components/IssueListView';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { KanbanFiltersDialog } from '@/shared/dialogs/kanban/KanbanFiltersDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@vibe/ui/components/Dropdown';
import { SearchableTagDropdownContainer } from '@/shared/components/SearchableTagDropdownContainer';
import type {
  Issue,
  IssueRelationship,
  IssuePriority,
  IssueTag,
  PullRequest,
  ProjectStatus,
  Tag,
} from 'shared/remote-types';
import { PROJECT_WORKSPACES_SHAPE } from 'shared/remote-types';
import { refreshShapeSource } from '@/shared/lib/electric/collections';
import { useIssueMultiSelect } from '@/shared/hooks/useIssueMultiSelect';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import { BulkActionBarContainer } from './BulkActionBarContainer';
import { AgentActivityIndicator } from './AgentActivityIndicator';
import { NewReleaseBadge } from './NewReleaseBadge';
import { computeKanbanMove } from '../model/computeKanbanMove';
import { buildKanbanMoveUpdates } from '../model/buildKanbanMoveUpdates';
import { createSyncGuard } from '../model/syncGuard';
import { buildProjectBreadcrumb } from '../model/buildProjectBreadcrumb';
import type { BreadcrumbEntry } from '../model/buildProjectBreadcrumb';
import {
  useKanbanDragHandler,
  type KanbanDragHandler,
  type KanbanMove,
} from '@/shared/components/ui-new/containers/KanbanDragHandlerContext';

const areStringSetsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
};

const areKanbanFiltersEqual = (
  left: KanbanFilterState,
  right: KanbanFilterState
): boolean => {
  if (left.searchQuery.trim() !== right.searchQuery.trim()) {
    return false;
  }

  if (!areStringSetsEqual(left.priorities, right.priorities)) {
    return false;
  }

  if (!areStringSetsEqual(left.tagIds, right.tagIds)) {
    return false;
  }

  return (
    left.sortField === right.sortField &&
    left.sortDirection === right.sortDirection
  );
};

const KANBAN_PROFILE_STORAGE_KEY = 'vk:profile:kanban';

/**
 * Development-only render probe. Enable it from DevTools with:
 *   localStorage.setItem('vk:profile:kanban', '1'); location.reload();
 *
 * It deliberately logs only when enabled so normal users pay no logging cost.
 * The probe measures React commits, not agent execution or backend streams.
 */
function reportKanbanRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number
) {
  if (
    !import.meta.env.DEV ||
    typeof window === 'undefined' ||
    window.localStorage.getItem(KANBAN_PROFILE_STORAGE_KEY) !== '1'
  ) {
    return;
  }

  console.debug('[kanban-render]', {
    id,
    phase,
    actualMs: Math.round(actualDuration * 100) / 100,
    baseMs: Math.round(baseDuration * 100) / 100,
    at: new Date().toISOString(),
  });
}

function LoadingState() {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-low">{t('states.loading')}</p>
    </div>
  );
}

/**
 * Renders the project breadcrumb inside the kanban header. Extracted from
 * the prior inline IIFE in `KanbanContainer` so the JSX stays linear and
 * the render logic is unit-addressable. Last segment is plain text;
 * earlier segments are buttons that call `onNavigateProject(id)`; segments
 * are separated by `/`. When `entries` is empty, `fallback` is shown
 * instead (the single-project / data-not-yet-loaded case).
 */
function ProjectBreadcrumb({
  entries,
  fallback,
  onNavigateProject,
}: {
  entries: readonly BreadcrumbEntry[];
  fallback: string;
  onNavigateProject: (id: string) => void;
}) {
  if (entries.length === 0) {
    return <>{fallback}</>;
  }
  return (
    <>
      {entries.map((entry, index) => {
        const isLast = index === entries.length - 1;
        return (
          <span key={entry.id} className="inline-flex items-center">
            {index > 0 && <span className="px-half text-low">/</span>}
            {isLast ? (
              <span className="truncate">{entry.name}</span>
            ) : (
              <button
                type="button"
                className="text-low hover:text-normal truncate cursor-pointer"
                onClick={() => onNavigateProject(entry.id)}
              >
                {entry.name}
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

type KanbanIssueCardProps = {
  issue: Issue;
  projectId: string;
  statusId?: string;
  isMobile: boolean;
  isOpen: boolean;
  isSelected: boolean;
  dragDisabled: boolean;
  issueWorkspaces: WorkspaceWithStats[];
  pullRequests: PullRequest[];
  relationshipRecords: IssueRelationship[];
  issuesById: Map<string, Issue>;
  subIssueChildren: Issue[];
  childWorkspacesByIssueId: Map<string, WorkspaceWithStats[]>;
  statusById: Map<string, ProjectStatus>;
  tags: Tag[];
  tagObjects: Tag[];
  allIssueTagsByIssueId: Map<string, IssueTag[]>;
  dispatchWorkspaces: { id: string; name: string }[];
  isSubIssuesExpanded: boolean;
  onCardClick: (issueId: string, event: MouseEvent<HTMLDivElement>) => void;
  onOpenIssue: (issueId: string) => void;
  onOpenWorkspace: (issueId: string, workspaceId: string) => void;
  onToggleSubIssues: (issueId: string) => void;
  onOpenSubBoard: (issueId: string) => void;
  onPriorityClick: (issueId: string) => void;
  onMoreActionsClick: (issueId: string) => void;
  onInfoClick: (issueId: string) => void;
  onTagToggle: (issueId: string, tagId: string) => void;
  onCreateTag: (data: { name: string; color: string }) => string;
  onDispatch: (issueId: string, workspaceId: string) => void;
};

/**
 * Keep issue-card rendering isolated from unrelated project updates, such as
 * agent activity changes in another workspace. The parent passes stable maps
 * and arrays from its memoized indexes; React.memo then skips this subtree
 * when the issue itself did not change.
 */
const KanbanIssueCard = memo(function KanbanIssueCard({
  issue,
  projectId,
  statusId,
  isMobile,
  isOpen,
  isSelected,
  dragDisabled,
  issueWorkspaces,
  pullRequests,
  relationshipRecords,
  issuesById,
  subIssueChildren,
  childWorkspacesByIssueId,
  statusById,
  tags,
  tagObjects,
  allIssueTagsByIssueId,
  dispatchWorkspaces,
  isSubIssuesExpanded,
  onCardClick,
  onOpenIssue,
  onOpenWorkspace,
  onToggleSubIssues,
  onOpenSubBoard,
  onPriorityClick,
  onMoreActionsClick,
  onInfoClick,
  onTagToggle,
  onCreateTag,
  onDispatch,
}: KanbanIssueCardProps) {
  const workspaceIdsShownOnCard = useMemo(
    () => new Set(issueWorkspaces.map((workspace) => workspace.id)),
    [issueWorkspaces]
  );
  const issueCardPullRequests = useMemo(
    () =>
      pullRequests.filter(
        (pullRequest) =>
          !pullRequest.workspace_id ||
          !workspaceIdsShownOnCard.has(pullRequest.workspace_id)
      ),
    [pullRequests, workspaceIdsShownOnCard]
  );
  const selectedTagIds = useMemo(
    () =>
      (allIssueTagsByIssueId.get(issue.id) ?? []).map(
        (issueTag) => issueTag.tag_id
      ),
    [allIssueTagsByIssueId, issue.id]
  );
  const relationships = useMemo(
    () =>
      resolveRelationshipsForIssue(issue.id, relationshipRecords, issuesById),
    [issue.id, relationshipRecords, issuesById]
  );

  return (
    <KanbanCard
      source={{
        kind: 'issue-move',
        issueId: issue.id,
        projectId,
        statusId: statusId ?? issue.status_id,
      }}
      name={issue.title}
      className="group"
      onClick={(event) => onCardClick(issue.id, event)}
      isOpen={isOpen}
      isMobile={isMobile}
      isSelected={isSelected}
      dragDisabled={dragDisabled}
    >
      <KanbanCardContent
        displayId={issue.simple_id}
        title={issue.title}
        description={issue.description}
        priority={issue.priority}
        tags={tagObjects}
        pullRequests={issueCardPullRequests}
        relationships={relationships}
        isSubIssue={!!issue.parent_issue_id}
        subIssueCount={subIssueChildren.length}
        isSubIssuesExpanded={isSubIssuesExpanded}
        onToggleSubIssues={() => onToggleSubIssues(issue.id)}
        onOpenSubBoard={() => onOpenSubBoard(issue.id)}
        isMobile={isMobile}
        onPriorityClick={(event) => {
          event.stopPropagation();
          onPriorityClick(issue.id);
        }}
        onMoreActionsClick={() => onMoreActionsClick(issue.id)}
        onInfoClick={() => onInfoClick(issue.id)}
        tagEditProps={{
          allTags: tags,
          selectedTagIds,
          onTagToggle: (tagId) => onTagToggle(issue.id, tagId),
          onCreateTag,
          renderTagEditor: ({
            allTags,
            selectedTagIds: currentSelectedTagIds,
            onTagToggle: toggleTag,
            onCreateTag: createTag,
            trigger,
          }) => (
            <SearchableTagDropdownContainer
              tags={allTags}
              selectedTagIds={currentSelectedTagIds}
              onTagToggle={toggleTag}
              onCreateTag={createTag}
              disabled={false}
              contentClassName=""
              trigger={trigger}
            />
          ),
        }}
      />
      {isSubIssuesExpanded && subIssueChildren.length > 0 && (
        <div className="mt-half flex flex-col gap-half border-l-2 border-border pl-half">
          {subIssueChildren.map((child) => {
            const childStatus = statusById.get(child.status_id);
            const childWorkspaces =
              childWorkspacesByIssueId.get(child.id) ?? [];
            return (
              <div
                key={child.id}
                className="flex flex-col gap-half rounded-sm px-half py-half hover:bg-secondary transition-colors"
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenIssue(child.id);
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  className="flex w-full items-center gap-half text-left text-sm text-normal"
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: `hsl(${childStatus?.color ?? '0 0% 60%'})`,
                    }}
                  />
                  <span className="shrink-0 font-ibm-plex-mono text-sm text-low">
                    {child.simple_id}
                  </span>
                  <span className="truncate">{child.title}</span>
                </button>
                {childWorkspaces.length > 0 && (
                  <div className="flex flex-col gap-half pl-3">
                    {childWorkspaces.map((workspace) => (
                      <IssueWorkspaceCard
                        key={workspace.id}
                        workspace={workspace}
                        onClick={
                          workspace.localWorkspaceId
                            ? () =>
                                onOpenWorkspace(
                                  child.id,
                                  workspace.localWorkspaceId!
                                )
                            : undefined
                        }
                        showOwner={false}
                        showStatusBadge={false}
                        showNoPrText={false}
                        compact
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {issueWorkspaces.length > 0 && (
        <div className="mt-base flex flex-col gap-half">
          {issueWorkspaces.map((workspace) => (
            <IssueWorkspaceCard
              key={workspace.id}
              workspace={workspace}
              onClick={
                workspace.localWorkspaceId
                  ? () => onOpenWorkspace(issue.id, workspace.localWorkspaceId!)
                  : undefined
              }
              showOwner={false}
              showStatusBadge={false}
              showNoPrText={false}
              compact
            />
          ))}
        </div>
      )}
      {dispatchWorkspaces.length > 0 && (
        <div className="mt-half">
          <KanbanWorkspaceDispatch
            workspaces={dispatchWorkspaces}
            currentWorkspaceIds={workspaceIdsShownOnCard}
            onDispatch={(workspaceId) => onDispatch(issue.id, workspaceId)}
          />
        </div>
      )}
    </KanbanCard>
  );
});

/**
 * KanbanContainer displays the kanban board using data from ProjectContext
 * (per-project issues/statuses/tags) plus the flat ProjectProvider
 * (project list). Must be rendered within both ProjectProvider layers
 * — the per-project one (issues) AND the flat one (project list).
 */
export function KanbanContainer() {
  const isMobile = useIsMobile();
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const routeState = useCurrentKanbanRouteState();

  // Get data from contexts (set up by WorkspacesLayout)
  const {
    projectId,
    issues,
    statuses,
    tags,
    issueTags,
    issueRelationships,
    getTagObjectsForIssue,
    getTagsForIssue,
    getWorkspacesForIssue,
    getRelationshipsForIssue,
    issuesById,
    insertIssueTag,
    removeIssueTag,
    insertTag,
    pullRequests,
    pullRequestIssues,
    workspaces,
    isLoading: projectLoading,
  } = useProjectContext();

  // Flat projects layer.
  const { data: projects } = useProjects();
  const { activeWorkspaces } = useWorkspaceContext();

  // Get project name by finding the project matching current projectId
  const projectName = projects.find((p) => p.id === projectId)?.name ?? '';

  const selectedKanbanIssueId = routeState.issueId;
  // Sub-issue board mode (2026-08-07): when on the sub-board route, the
  // board is filtered to show only the children of the parent issue. The
  // regular KanbanContainer UI (columns, drag-and-drop, etc.) is reused —
  // only the candidate issue set is narrowed.
  const parentIssueId = routeState.parentIssueId;
  const boardIssues = useMemo(
    () =>
      parentIssueId
        ? issues.filter((i) => i.parent_issue_id === parentIssueId)
        : issues,
    [issues, parentIssueId]
  );
  const issueComposerKey = useMemo(
    () => buildKanbanIssueComposerKey(routeState.hostId, projectId),
    [routeState.hostId, projectId]
  );
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const isIssueComposerOpen = issueComposer !== null;
  const openIssue = useCallback(
    (issueId: string) => {
      if (isIssueComposerOpen) {
        closeKanbanIssueComposer(issueComposerKey);
      }

      // On the sub-board, selecting a card stays on the sub-board (keeps the
      // parent filter) and just swaps the open child via the `?issue=` search
      // param. Otherwise navigate to the main issue route.
      if (parentIssueId) {
        appNavigation.goToProjectIssueSubBoard(
          projectId,
          parentIssueId,
          issueId
        );
      } else {
        appNavigation.goToProjectIssue(projectId, issueId);
      }
    },
    [
      isIssueComposerOpen,
      issueComposerKey,
      appNavigation,
      projectId,
      parentIssueId,
    ]
  );
  const openIssueWorkspace = useCallback(
    (issueId: string, workspaceAttemptId: string) => {
      appNavigation.goToProjectIssueWorkspace(
        projectId,
        issueId,
        workspaceAttemptId
      );
    },
    [appNavigation, projectId]
  );
  const openIssueSubBoard = useCallback(
    (issueId: string) =>
      appNavigation.goToProjectIssueSubBoard(projectId, issueId),
    [appNavigation, projectId]
  );
  // Get setter and executor from ActionsContext
  const {
    setDefaultCreateStatusId,
    executeAction,
    openPrioritySelection,
    createIssue,
  } = useActions();
  const startCreate = useCallback(
    (options?: ProjectIssueCreateOptions) => {
      void createIssue(options);
    },
    [createIssue]
  );
  const openProjectsGuide = useCallback(() => {
    executeAction(Actions.ProjectsGuide);
  }, [executeAction]);

  const projectViewSelection = useUiPreferencesStore(
    (s) => s.kanbanProjectViewSelections[projectId]
  );
  const projectViewPreferencesById = useUiPreferencesStore(
    (s) => s.kanbanProjectViewPreferences[projectId]
  );
  const setKanbanProjectView = useUiPreferencesStore(
    (s) => s.setKanbanProjectView
  );
  const setKanbanProjectViewFilters = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewFilters
  );
  const setKanbanProjectViewShowSubIssues = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewShowSubIssues
  );
  const setKanbanProjectViewShowWorkspaces = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewShowWorkspaces
  );
  const setKanbanProjectViewHideBlocked = useUiPreferencesStore(
    (s) => s.setKanbanProjectViewHideBlocked
  );
  const clearKanbanProjectViewPreferences = useUiPreferencesStore(
    (s) => s.clearKanbanProjectViewPreferences
  );
  const resolvedProjectState = useMemo(
    () => resolveKanbanProjectState(projectViewSelection),
    [projectViewSelection]
  );
  const {
    activeViewId,
    filters: defaultKanbanFilters,
    showSubIssues: defaultShowSubIssues,
    showWorkspaces: defaultShowWorkspaces,
    hideBlocked: defaultHideBlocked,
  } = resolvedProjectState;
  const projectViewPreferences = projectViewPreferencesById?.[activeViewId];
  const kanbanFilters = projectViewPreferences?.filters ?? defaultKanbanFilters;
  const showSubIssues =
    projectViewPreferences?.showSubIssues ?? defaultShowSubIssues;
  const showWorkspaces =
    projectViewPreferences?.showWorkspaces ?? defaultShowWorkspaces;
  const hideBlocked = projectViewPreferences?.hideBlocked ?? defaultHideBlocked;

  const hasActiveFilters = useMemo(
    () =>
      !areKanbanFiltersEqual(kanbanFilters, defaultKanbanFilters) ||
      showSubIssues !== defaultShowSubIssues ||
      showWorkspaces !== defaultShowWorkspaces ||
      hideBlocked !== defaultHideBlocked,
    [
      kanbanFilters,
      defaultKanbanFilters,
      showSubIssues,
      defaultShowSubIssues,
      showWorkspaces,
      defaultShowWorkspaces,
      hideBlocked,
      defaultHideBlocked,
    ]
  );
  const shouldAnimateCreateButton = issues.length === 0;

  // Compute resolved status IDs for the blocked filter.
  // A blocking issue is considered resolved when it's in a terminal column —
  // the backend marks those explicitly via `is_terminal` (reordering columns
  // can no longer change which one is "done").
  const doneStatusIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of statuses) {
      if (s.is_terminal) ids.add(s.id);
    }
    return ids;
  }, [statuses]);

  // Sub-issue board (parentIssueId set): every candidate already has a
  // `parent_issue_id`. The `showSubIssues` filter DROPS exactly those, so if
  // the user has it off (the default) the board would be empty. Force it on
  // here so the children always pass through the filter pipeline.
  const effectiveShowSubIssues = showSubIssues || !!parentIssueId;

  const { filteredIssues } = useKanbanFilters({
    issues: boardIssues,
    issueTags,
    issueRelationships,
    issuesById,
    doneStatusIds,
    filters: kanbanFilters,
    showSubIssues: effectiveShowSubIssues,
    hideBlocked,
  });

  const setKanbanSearchQuery = useCallback(
    (searchQuery: string) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        searchQuery,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanPriorities = useCallback(
    (priorities: IssuePriority[]) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        priorities,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanTags = useCallback(
    (tagIds: string[]) => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        tagIds,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setKanbanSort = useCallback(
    (sortField: KanbanSortField, sortDirection: 'asc' | 'desc') => {
      setKanbanProjectViewFilters(projectId, activeViewId, {
        ...kanbanFilters,
        sortField,
        sortDirection,
      });
    },
    [activeViewId, kanbanFilters, projectId, setKanbanProjectViewFilters]
  );

  const setShowSubIssues = useCallback(
    (show: boolean) => {
      setKanbanProjectViewShowSubIssues(projectId, activeViewId, show);
    },
    [activeViewId, projectId, setKanbanProjectViewShowSubIssues]
  );

  const setShowWorkspaces = useCallback(
    (show: boolean) => {
      setKanbanProjectViewShowWorkspaces(projectId, activeViewId, show);
    },
    [activeViewId, projectId, setKanbanProjectViewShowWorkspaces]
  );

  const setHideBlocked = useCallback(
    (hide: boolean) => {
      setKanbanProjectViewHideBlocked(projectId, activeViewId, hide);
    },
    [activeViewId, projectId, setKanbanProjectViewHideBlocked]
  );

  const clearKanbanFilters = useCallback(() => {
    clearKanbanProjectViewPreferences(projectId, activeViewId);
  }, [activeViewId, clearKanbanProjectViewPreferences, projectId]);

  const handleKanbanProjectViewChange = useCallback(
    (viewId: string) => {
      setKanbanProjectView(projectId, viewId);
    },
    [projectId, setKanbanProjectView]
  );
  const kanbanViewMode = useUiPreferencesStore((s) => s.kanbanViewMode);
  const listViewStatusFilter = useUiPreferencesStore(
    (s) => s.listViewStatusFilter
  );
  const setKanbanViewMode = useUiPreferencesStore((s) => s.setKanbanViewMode);
  const setListViewStatusFilter = useUiPreferencesStore(
    (s) => s.setListViewStatusFilter
  );
  // Reset view mode when navigating projects
  const prevProjectIdRef = useRef<string | null>(null);

  // Track when drag-drop sync is in progress to prevent flicker
  const isSyncingCountRef = useRef(0);
  const [syncCount, setSyncCount] = useState(0);

  // Single source of truth for `sortField === 'sort_order'`. Used by the
  // swap branch gate, the move branch gate (P4-B1), and the
  // `positionalReorderEnabled` prop. Plain string compare — no memo.
  const isManualSort = kanbanFilters.sortField === 'sort_order';

  useEffect(() => {
    if (
      prevProjectIdRef.current !== null &&
      prevProjectIdRef.current !== projectId
    ) {
      setKanbanViewMode('kanban');
      setListViewStatusFilter(null);
    }

    prevProjectIdRef.current = projectId;
  }, [projectId, setKanbanViewMode, setListViewStatusFilter]);

  // Sort all statuses for display settings
  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.sort_order - b.sort_order),
    [statuses]
  );

  // Filter statuses: visible (non-hidden) for kanban, hidden for tabs
  const visibleStatuses = useMemo(
    () => sortedStatuses.filter((s) => !s.hidden),
    [sortedStatuses]
  );

  // Map status ID to 1-based column index for sort_order calculation
  const statusColumnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    visibleStatuses.forEach((status, index) => {
      map.set(status.id, index + 1);
    });
    return map;
  }, [visibleStatuses]);

  const hiddenStatuses = useMemo(
    () => sortedStatuses.filter((s) => s.hidden),
    [sortedStatuses]
  );

  const defaultCreateStatusId = useMemo(() => {
    if (kanbanViewMode === 'kanban') {
      return visibleStatuses[0]?.id;
    }
    if (listViewStatusFilter) {
      return listViewStatusFilter;
    }
    return sortedStatuses[0]?.id;
  }, [kanbanViewMode, visibleStatuses, listViewStatusFilter, sortedStatuses]);

  // Update default create status for command bar based on current tab
  useEffect(() => {
    setDefaultCreateStatusId(defaultCreateStatusId);
  }, [defaultCreateStatusId, setDefaultCreateStatusId]);

  // Get statuses to display in list view (all or filtered to one)
  const listViewStatuses = useMemo(() => {
    if (listViewStatusFilter) {
      return sortedStatuses.filter((s) => s.id === listViewStatusFilter);
    }
    return sortedStatuses;
  }, [sortedStatuses, listViewStatusFilter]);

  // Track items as arrays of IDs grouped by status
  const [items, setItems] = useState<Record<string, string[]>>({});
  // Items mirror, used by the move handler to compute the next state
  // outside the React updater (the previous implementation mutated a `let`
  // inside the setItems updater, which is fragile under concurrent React).
  const itemsRef = useRef<Record<string, string[]>>({});
  itemsRef.current = items;
  // Optimistic status overrides for cards the operator just moved. The
  // fallback shape snapshot is a full truncate+rewrite, so a fetch that
  // started before a write (or a stale lookup) would otherwise re-render
  // the card in its old column. Overrides win until the snapshot agrees.
  const pendingStatusRef = useRef<
    Map<string, { statusId: string; at: number }>
  >(new Map());
  const PENDING_STATUS_TTL_MS = 15_000;
  const [isFiltersDialogOpen, setIsFiltersDialogOpen] = useState(false);
  const isProjectTerminalOpen = useUiPreferencesStore(
    (s) => s.isProjectTerminalOpen
  );
  const toggleProjectTerminal = useUiPreferencesStore(
    (s) => s.toggleProjectTerminal
  );

  // Sync items from filtered issues when they change
  useEffect(() => {
    // Skip rebuild during drag-drop sync to prevent flicker
    if (syncCount > 0 || isSyncingCountRef.current > 0) {
      return;
    }

    const { sortField, sortDirection } = kanbanFilters;
    const grouped: Record<string, string[]> = {};

    // Resolve optimistic overrides before grouping: a card the operator
    // just moved keeps its new column even if the incoming snapshot still
    // reports the old status (full truncate+rewrite snapshots, stale
    // in-flight fetches). Drop entries once the snapshot agrees or the
    // short TTL expires, so real external changes still win afterwards.
    const pending = pendingStatusRef.current;
    if (pending.size > 0) {
      const currentStatusById = new Map(
        filteredIssues.map((issue) => [issue.id, issue.status_id] as const)
      );
      const now = Date.now();
      for (const [issueId, entry] of pending) {
        const current = currentStatusById.get(issueId);
        if (current === undefined || current === entry.statusId) {
          pending.delete(issueId);
          continue;
        }
        if (now - entry.at > PENDING_STATUS_TTL_MS) {
          pending.delete(issueId);
        }
      }
    }
    const effectiveStatus = (issue: { id: string; status_id: string }) =>
      pending.get(issue.id)?.statusId ?? issue.status_id;

    for (const status of statuses) {
      // Filter issues for this status
      let statusIssues = filteredIssues.filter(
        (i) => effectiveStatus(i) === status.id
      );

      // Sort within column based on user preference
      statusIssues = [...statusIssues].sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case 'priority':
            comparison =
              (a.priority ? PRIORITY_ORDER[a.priority] : Infinity) -
              (b.priority ? PRIORITY_ORDER[b.priority] : Infinity);
            break;
          case 'created_at':
            comparison =
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime();
            break;
          case 'updated_at':
            comparison =
              new Date(a.updated_at).getTime() -
              new Date(b.updated_at).getTime();
            break;
          case 'title':
            comparison = a.title.localeCompare(b.title);
            break;
          case 'sort_order':
          default:
            comparison = a.sort_order - b.sort_order;
        }
        return sortDirection === 'desc' ? -comparison : comparison;
      });

      grouped[status.id] = statusIssues.map((i) => i.id);
    }
    setItems(grouped);
  }, [filteredIssues, statuses, kanbanFilters, syncCount]);

  // Full-Issue Record intentionally stays local: rendering needs fields beyond
  // the shared drag lookup projection.
  const issueMap = useMemo(() => {
    const map: Record<string, (typeof issues)[0]> = {};
    for (const issue of issues) {
      map[issue.id] = issue;
    }
    return map;
  }, [issues]);

  // Sub-issue expansion on the board (2026-08-07): parent cards that have
  // children show an expandable "↳ N" badge; expanding reveals the children
  // inline. Computed from the FULL issues list (not the filtered one) so the
  // badge appears even when the Sub-issues filter hides standalone sub-issue
  // cards. A sub-issue lives under its parent regardless of which status
  // column the child itself sits in.
  const childrenByParentId = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of issues) {
      const pid = issue.parent_issue_id;
      if (!pid) continue;
      const arr = map.get(pid);
      if (arr) arr.push(issue);
      else map.set(pid, [issue]);
    }
    for (const arr of map.values()) {
      arr.sort(
        (a, b) =>
          (a.parent_issue_sort_order ?? 0) - (b.parent_issue_sort_order ?? 0)
      );
    }
    return map;
  }, [issues]);

  const statusById = useMemo(() => {
    const map = new Map<string, (typeof statuses)[number]>();
    for (const s of statuses) map.set(s.id, s);
    return map;
  }, [statuses]);

  const [expandedSubIssueParents, setExpandedSubIssueParents] = useState<
    Set<string>
  >(() => new Set());
  const toggleSubIssuesExpanded = useCallback((parentId: string) => {
    setExpandedSubIssueParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }, []);

  const [cardInfoIssueId, setCardInfoIssueId] = useState<string | null>(null);
  const [cardInfoOpen, setCardInfoOpen] = useState(false);
  const openCardInfo = useCallback((issueId: string) => {
    setCardInfoIssueId(issueId);
    setCardInfoOpen(true);
  }, []);

  const localWorkspacesById = useMemo(() => {
    const map = new Map<string, (typeof activeWorkspaces)[number]>();

    for (const workspace of activeWorkspaces) {
      map.set(workspace.id, workspace);
    }

    return map;
  }, [activeWorkspaces]);

  const queryClient = useQueryClient();

  // Every dispatchable workspace (active, with a local id) for the per-card
  // quick-dispatch dropdown. Orchestrator/recurrent workspaces are excluded:
  // dispatching a card into them would corrupt their orchestration loop.
  const dispatchWorkspaces = useMemo(
    () =>
      activeWorkspaces
        .filter(
          (workspace) =>
            !!workspace.id &&
            workspace.kind !== 'orchestrator' &&
            workspace.kind !== 'recurrent'
        )
        .map((workspace) => ({ id: workspace.id, name: workspace.name })),
    [activeWorkspaces]
  );

  const handleDispatchIssueToWorkspace = useCallback(
    async (issueId: string, workspaceId: string) => {
      try {
        await workspacesApi.dispatchIssueToWorkspace(issueId, workspaceId);
        // The workspace↔issue relink only surfaces through the workspaces
        // shape, which the local build polls on a slow interval. Force a
        // refresh so the card picks up the link (and the running indicator)
        // immediately instead of on the next poll.
        refreshShapeSource(PROJECT_WORKSPACES_SHAPE, { project_id: projectId });
        // A dispatch touches many disparate caches (board, workspace session,
        // execution processes, branch status, the issue's Workspaces section),
        // all keyed differently. Scoping to a subset would leave stale UI; the
        // local SQLite backing store makes a full invalidation cheap.
        await queryClient.invalidateQueries();
      } catch (error) {
        ConfirmDialog.show({
          title: t('common:error'),
          message: error instanceof Error ? error.message : String(error),
          confirmText: t('common:ok'),
          showCancelButton: false,
        });
      }
    },
    [queryClient, t, projectId]
  );

  const prsByWorkspaceId = useMemo(() => {
    const map = new Map<string, WorkspacePr[]>();

    for (const pr of pullRequests) {
      if (!pr.workspace_id) continue;

      const prs = map.get(pr.workspace_id) ?? [];
      prs.push({
        number: pr.number,
        url: pr.url,
        status: pr.status as 'open' | 'merged' | 'closed',
      });
      map.set(pr.workspace_id, prs);
    }

    return map;
  }, [pullRequests]);

  // Index card decorations once per shape update. Calling the context
  // helpers inside every card used to scan the full tags/relationships/PRs
  // arrays repeatedly during the board's first render.
  const tagsById = useMemo(
    () => new Map(tags.map((tag) => [tag.id, tag])),
    [tags]
  );

  const issueTagsByIssueId = useMemo(() => {
    const grouped = new Map<string, (typeof issueTags)[number][]>();
    for (const issueTag of issueTags) {
      const existing = grouped.get(issueTag.issue_id);
      if (existing) existing.push(issueTag);
      else grouped.set(issueTag.issue_id, [issueTag]);
    }
    return grouped;
  }, [issueTags]);

  const tagObjectsByIssueId = useMemo(() => {
    const grouped = new Map<string, (typeof tags)[number][]>();
    for (const issueTag of issueTags) {
      const tag = tagsById.get(issueTag.tag_id);
      if (!tag) continue;
      const existing = grouped.get(issueTag.issue_id);
      if (existing) existing.push(tag);
      else grouped.set(issueTag.issue_id, [tag]);
    }
    return grouped;
  }, [issueTags, tagsById]);

  const relationshipsByIssueId = useMemo(() => {
    const grouped = new Map<string, (typeof issueRelationships)[number][]>();
    for (const relationship of issueRelationships) {
      const issueIds = [relationship.issue_id];
      if (relationship.related_issue_id !== relationship.issue_id) {
        issueIds.push(relationship.related_issue_id);
      }
      for (const issueId of issueIds) {
        const existing = grouped.get(issueId);
        if (existing) existing.push(relationship);
        else grouped.set(issueId, [relationship]);
      }
    }
    return grouped;
  }, [issueRelationships]);

  const pullRequestsByIssueId = useMemo(() => {
    const pullRequestsById = new Map(
      pullRequests.map((pullRequest) => [pullRequest.id, pullRequest])
    );
    const grouped = new Map<string, (typeof pullRequests)[number][]>();
    for (const link of pullRequestIssues) {
      const pullRequest = pullRequestsById.get(link.pull_request_id);
      if (!pullRequest) continue;
      const existing = grouped.get(link.issue_id);
      if (existing) existing.push(pullRequest);
      else grouped.set(link.issue_id, [pullRequest]);
    }
    return grouped;
  }, [pullRequests, pullRequestIssues]);

  const workspacesByIssueId = useMemo(() => {
    if (!showWorkspaces) {
      return new Map<string, WorkspaceWithStats[]>();
    }

    const map = new Map<string, WorkspaceWithStats[]>();

    for (const workspace of workspaces) {
      if (
        workspace.archived ||
        !workspace.issue_id ||
        !workspace.local_workspace_id
      ) {
        continue;
      }

      const localWorkspace = localWorkspacesById.get(
        workspace.local_workspace_id
      );
      if (!localWorkspace) continue;

      const workspaceWithStats: WorkspaceWithStats = {
        id: workspace.id,
        localWorkspaceId: workspace.local_workspace_id,
        name: workspace.name,
        archived: workspace.archived,
        filesChanged: workspace.files_changed ?? 0,
        linesAdded: workspace.lines_added ?? 0,
        linesRemoved: workspace.lines_removed ?? 0,
        prs: prsByWorkspaceId.get(workspace.id) ?? [],
        owner: null,
        updatedAt: workspace.updated_at,
        isRunning: localWorkspace.isRunning,
        hasPendingApproval: localWorkspace.hasPendingApproval,
        hasRunningDevServer: localWorkspace.hasRunningDevServer,
        hasUnseenActivity: localWorkspace.hasUnseenActivity,
        latestProcessCompletedAt: localWorkspace.latestProcessCompletedAt,
        latestProcessStatus: localWorkspace.latestProcessStatus,
      };
      const existing = map.get(workspace.issue_id);
      if (existing) existing.push(workspaceWithStats);
      else map.set(workspace.issue_id, [workspaceWithStats]);
    }

    return map;
  }, [showWorkspaces, workspaces, localWorkspacesById, prsByWorkspaceId]);

  // Calculate sort_order based on column index and issue position
  // Formula: 1000 * [COLUMN_INDEX] + [ISSUE_INDEX] (both 1-based)
  const calculateSortOrder = useCallback(
    (statusId: string, issueIndex: number): number => {
      const columnIndex = statusColumnIndexMap.get(statusId) ?? 1;
      return 1000 * columnIndex + (issueIndex + 1);
    },
    [statusColumnIndexMap]
  );

  // Fire the REST + shape refresh. `isSyncingCountRef` gates the items-rebuild
  // effect so the optimistic local order isn't trampled by a slow shape
  // sync; decremented in both branches once the shape refresh resolves (or
  // the catch runs). On failure we just log + force a shape refresh — the
  // failed bulkUpdateIssues left the backend untouched, so the next shape
  // sync restores authoritative state.
  //
  // P4-BUG1: a 10s safety net decrements the counter if `onSettled` never
  // fires (network drop, suspended tab). Without it the counter would stay
  // >0 forever and the items-rebuild effect would freeze the board.
  const applyKanbanMove = useCallback(
    (updates: BulkUpdateIssueItem[], projectIdArg: string) => {
      isSyncingCountRef.current += 1;
      setSyncCount((c) => c + 1);
      const guard = createSyncGuard({
        decrement: () => {
          isSyncingCountRef.current -= 1;
          setSyncCount((c) => Math.max(0, c - 1));
        },
      });
      persistIssues(updates, projectIdArg, {
        onError: (err) =>
          console.error('Failed to bulk update sort order:', err),
        onSettled: guard.bind(() => {
          isSyncingCountRef.current -= 1;
          setSyncCount((c) => Math.max(0, c - 1));
        }),
      });
    },
    []
  );

  // Move-based handler. Called from two paths:
  //   1. The shared custom drag system via KanbanDragHandlerProvider.
  //      Cross-surface drops land here when the drop target resolves
  //      to a bare-UUID kanban column (column move → append).
  //   2. The legacy list-view adapter (IssueListView) which still uses
  //      hello-pangea for positional reordering inside columns.
  // Thin orchestrator: guard → compute next state → build updates →
  // apply (REST + shape refresh).
  const handleKanbanMove = useCallback(
    (move: KanbanMove) => {
      const { swapWithIssueId } = move;
      // Same-column SWAP of two cards: exchange their status_id +
      // sort_order optimistically (no round-trip flash — the visual
      // preview already reordered the DOM, so committing immediately in
      // the local items map prevents the "updated → old → correct" flicker
      // the user saw on successful swaps).
      // Only same-status swaps are reachable: the drag controller filters
      // card candidates by `data-drop-target-status === source.statusId`,
      // so a and b necessarily share the same column. The cross-status
      // branch below is defensive against a future controller change.
      if (swapWithIssueId) {
        // P4-D2: gate the swap on the single `isManualSort` const. Under
        // priority/created_at/title sort, swapping two cards touches only
        // sort_order — the active sort field would re-derive order on the
        // next shape sync, so the swap is a no-op for the user.
        if (!isManualSort) return;
        const a = issueMap[move.issueId];
        const b = issueMap[swapWithIssueId];
        if (!a || !b) return;
        if (move.swapWithIssueId === move.issueId) return;
        // Defensive: if a cross-status swap reaches here, treat it as a
        // move of card `a` to card `b`'s status column.
        if (a.status_id !== b.status_id) {
          handleKanbanMove({
            issueId: a.id,
            fromStatusId: a.status_id,
            toStatusId: b.status_id,
          });
          return;
        }
        setItems((prev) => {
          const next = { ...prev };
          const aCol = [...(next[a.status_id] ?? [])];
          const ai = aCol.indexOf(a.id);
          const bi = aCol.indexOf(b.id);
          if (ai !== -1 && bi !== -1) {
            [aCol[ai], aCol[bi]] = [aCol[bi], aCol[ai]];
            next[a.status_id] = aCol;
          }
          itemsRef.current = next;
          return next;
        });
        isSyncingCountRef.current += 1;
        setSyncCount((c) => c + 1);
        // P4-BUG1: same 10s safety net as the move branch — a swap
        // whose `bulkUpdateIssues` never settles must NOT freeze the
        // items-rebuild gate.
        const guard = createSyncGuard({
          decrement: () => {
            isSyncingCountRef.current -= 1;
            setSyncCount((c) => Math.max(0, c - 1));
          },
        });
        persistIssueSwap(a, b, projectId, {
          onError: (err) => console.error('[dnd] kanban swap failed:', err),
          onSettled: guard.bind(() => {
            isSyncingCountRef.current -= 1;
            setSyncCount((c) => Math.max(0, c - 1));
          }),
        });
        return;
      }

      const { fromStatusId: from, toStatusId: to } = move;
      // Same-status drop is a no-op when EITHER:
      //   (a) no explicit insertion index is supplied — the custom DnD
      //       controller never produces a same-status column target (it
      //       filters cards by `data-drop-target-status === source.statusId`),
      //       so the only same-status-with-index path is the legacy
      //       list-view adapter — a positional reorder inside the same
      //       column.
      //   (b) the sort field is non-positional (priority/created_at/
      //       title). Under non-manual sort a same-status list-view
      //       reorder (explicit index) would otherwise fire a useless
      //       `{status_id: to}` write (to === from) and hold the
      //       items-rebuild gate open for 10s. The legacy adapter only
      //       emits an explicit index when its `onDragEnd` ran; bail
      //       here so the commit short-circuits before the gate holds
      //       and the backend round-trips a no-op (P5-E1).
      if (from === to && (move.index === undefined || !isManualSort)) return;

      // P4-B1: under non-manual sort, the column is ordered by a
      // non-positional field (priority/created_at/title). The custom
      // drop controller's resolved slot is OPTIMISTIC — the next shape
      // sync re-derives order from the active sort. Drop the index so
      // `computeKanbanMove` appends, and ask `buildKanbanMoveUpdates`
      // for a status-only update (no sort_order rewrite).
      const commitMove = (
        moveToCommit: KanbanMove = move,
        allowUnmergedDone = false
      ) => {
        const resolvedMove =
          isManualSort || moveToCommit === move
            ? moveToCommit
            : { ...moveToCommit, index: undefined };
        const newItems = computeKanbanMove(itemsRef.current, resolvedMove);
        const updates = buildKanbanMoveUpdates({
          newItems,
          move: resolvedMove,
          isManualSort,
          calculateSortOrder,
          statusColumnIndexMap,
        }).map((update) => {
          const isDoneMove =
            allowUnmergedDone || doneStatusIds.has(resolvedMove.toStatusId);
          if (isDoneMove) {
            return {
              ...update,
              changes: { ...update.changes, allow_unmerged_done: true },
            };
          }
          return update;
        });

        itemsRef.current = newItems;
        setItems(newItems);
        // Optimistic status protection: remember the operator's intended
        // status for the moved card so a shape snapshot that still carries
        // the pre-move row (in-flight fallback fetch, stale lookup) cannot
        // snap the card back. Cleared automatically once the fetched row
        // agrees, or after a short TTL.
        pendingStatusRef.current.set(moveToCommit.issueId, {
          statusId: moveToCommit.toStatusId,
          at: Date.now(),
        });
        applyKanbanMove(updates, projectId);
      };

      // Done is a protected terminal state. The dialog is intentionally
      // asynchronous: no optimistic state or REST write happens until the
      // operator chooses how the card should be completed.
      if (from !== to && doneStatusIds.has(to)) {
        void (async () => {
          const decision = await ConfirmDialog.show({
            title: 'Complete card',
            message:
              'This card has not been integrated yet. Choose how to move it.',
            confirmText: 'Move and merge',
            alternativeText: 'Move without merging',
            cancelText: 'Cancel',
            variant: 'info',
          });

          if (decision === 'canceled') return;

          if (decision === 'alternative') {
            // Operator explicitly chose "Move without merging":
            // "apenas move para done sem fazer nada"
            commitMove(move, true);
            return;
          }

          if (decision === 'confirmed') {
            const linkedWorkspaces = getWorkspacesForIssue(move.issueId);
            const linkedWs = linkedWorkspaces.find(
              (w) => w.local_workspace_id || w.id
            );
            const workspaceId = linkedWs?.local_workspace_id || linkedWs?.id;

            if (!workspaceId) {
              // No linked workspace to merge: move to Done directly
              commitMove(move, true);
              return;
            }

            // Route through In Progress with done_intent
            const inProgressStatus =
              statuses.find((s) => s.name.toLowerCase().includes('progress')) ||
              statuses[1];
            const inProgressStatusId = inProgressStatus?.id || from;

            if (inProgressStatusId !== from) {
              commitMove({ ...move, toStatusId: inProgressStatusId }, false);
            }

            let repoIdForMergeRetry: string | null = null;
            // After any successful merge, offer to pop our own leftover
            // stashes (pre-merge stash, agent cleanups) so WIP never sits
            // forgotten — whoever stashed it, the pop is offered here.
            // Defined outside try/catch: both the success path and the
            // dialog handlers below use it.
            const offerStashPop = async (
              mergeResult: { pending_stashes?: string[] } | void,
              repoId: string
            ) => {
              const pending = mergeResult?.pending_stashes ?? [];
              if (pending.length === 0) return;
              const popDecision = await ConfirmDialog.show({
                title: 'Merge succeeded',
                message: `There ${
                  pending.length === 1
                    ? 'is 1 stashed change set'
                    : `are ${pending.length} stashed change sets`
                } from earlier cleanup (${pending[0]}${
                  pending.length > 1 ? ', …' : ''
                }). Pop the latest back into the working tree now?`,
                confirmText: 'Pop stash',
                alternativeText: 'Later',
                cancelText: 'Later',
                variant: 'info',
              });
              if (popDecision !== 'confirmed') return;
              try {
                await workspacesApi.popWorkspaceStash(workspaceId, {
                  repo_id: repoId,
                });
              } catch (popError) {
                await ConfirmDialog.show({
                  title: 'Stash pop failed',
                  message:
                    popError instanceof Error
                      ? popError.message
                      : 'Could not restore the stash. Resolve manually with git stash pop.',
                  confirmText: 'OK',
                  showCancelButton: false,
                });
              }
            };
            try {
              await bulkUpdateIssues([
                {
                  id: move.issueId,
                  changes: {
                    status_id: inProgressStatusId,
                    extension_metadata: { done_intent: true },
                  },
                },
              ]);

              const repos = await workspacesApi.getRepos(workspaceId);
              const repo = repos[0];
              if (!repo) {
                throw new Error(
                  'The linked workspace has no repository configured.'
                );
              }
              repoIdForMergeRetry = repo.id;
              const mergeResult = await workspacesApi.merge(workspaceId, {
                repo_id: repo.id,
              });
              commitMove(move, true);
              await offerStashPop(mergeResult, repo.id);
              return;
            } catch (error) {
              const block = getDirtyWorktreeBlock(error);
              if (block && repoIdForMergeRetry) {
                const resolution = await MergeBlockedDialog.show({ ...block });
                const action = resolution.action;
                const userNote = resolution.instructions;
                if (action === 'move-without-merge') {
                  commitMove(move, true);
                  return;
                }
                if (action === 'stash-retry') {
                  try {
                    await workspacesApi.stashWorkspaceChanges(workspaceId, {
                      repo_id: repoIdForMergeRetry,
                    });
                    const retryResult = await workspacesApi.merge(workspaceId, {
                      repo_id: repoIdForMergeRetry,
                    });
                    commitMove(move, true);
                    await offerStashPop(retryResult, repoIdForMergeRetry);
                  } catch (retryError) {
                    await ConfirmDialog.show({
                      title: 'Retry failed',
                      message:
                        retryError instanceof Error
                          ? retryError.message
                          : 'Stash or retry failed. The card was left in progress.',
                      confirmText: 'OK',
                      showCancelButton: false,
                    });
                  }
                  return;
                }
                if (action === 'delegate') {
                  try {
                    const delegation = await workspacesApi.delegateMergeBlock(
                      workspaceId,
                      {
                        repo_id: repoIdForMergeRetry,
                        ...(userNote ? { user_note: userNote } : {}),
                      }
                    );
                    if (delegation.delegated) {
                      await ConfirmDialog.show({
                        title: 'Cleanup delegated to agent',
                        message:
                          'The agent will clean the working tree on its next run. Retry the merge after it reports back.',
                        confirmText: 'OK',
                        showCancelButton: false,
                      });
                    } else if (delegation.reason === 'already_clean') {
                      const retryResult = await workspacesApi.merge(
                        workspaceId,
                        {
                          repo_id: repoIdForMergeRetry,
                        }
                      );
                      commitMove(move, true);
                      await offerStashPop(retryResult, repoIdForMergeRetry);
                    } else {
                      await ConfirmDialog.show({
                        title: 'No agent to delegate to',
                        message:
                          'This workspace has no configured agent executor. Start an agent run first, then delegate the cleanup.',
                        confirmText: 'OK',
                        showCancelButton: false,
                      });
                    }
                  } catch (delegateError) {
                    await ConfirmDialog.show({
                      title: 'Delegation failed',
                      message:
                        delegateError instanceof Error
                          ? delegateError.message
                          : 'Could not delegate the cleanup. The card was left in progress.',
                      confirmText: 'OK',
                      showCancelButton: false,
                    });
                  }
                  return;
                }
                return;
              }
              const conflict = getMergeConflictsBlock(error);
              if (conflict && repoIdForMergeRetry) {
                const resolution = await MergeBlockedDialog.show({
                  branch: conflict.targetBranch,
                  modified: conflict.conflictedFiles,
                  untracked: [],
                  message: conflict.message,
                  mode: 'conflicts',
                });
                const action = resolution.action;
                const userNote = resolution.instructions;
                if (action === 'move-without-merge') {
                  commitMove(move, true);
                  return;
                }
                if (action === 'delegate') {
                  try {
                    const delegation = await workspacesApi.delegateMergeBlock(
                      workspaceId,
                      {
                        repo_id: repoIdForMergeRetry,
                        note: 'merge-conflict',
                        ...(userNote ? { user_note: userNote } : {}),
                      }
                    );
                    if (delegation.delegated) {
                      await ConfirmDialog.show({
                        title: 'Resolution delegated to agent',
                        message:
                          'The agent will resolve the conflicts and commit the result on its next run. Retry the merge after it reports back.',
                        confirmText: 'OK',
                        showCancelButton: false,
                      });
                    } else if (delegation.reason === 'already_clean') {
                      const retryResult = await workspacesApi.merge(
                        workspaceId,
                        {
                          repo_id: repoIdForMergeRetry,
                        }
                      );
                      commitMove(move, true);
                      await offerStashPop(retryResult, repoIdForMergeRetry);
                    } else {
                      await ConfirmDialog.show({
                        title: 'No agent to delegate to',
                        message:
                          'This workspace has no configured agent executor. Start an agent run first, then delegate the resolution.',
                        confirmText: 'OK',
                        showCancelButton: false,
                      });
                    }
                  } catch (delegateError) {
                    await ConfirmDialog.show({
                      title: 'Delegation failed',
                      message:
                        delegateError instanceof Error
                          ? delegateError.message
                          : 'Could not delegate the resolution. The card was left in progress.',
                      confirmText: 'OK',
                      showCancelButton: false,
                    });
                  }
                  return;
                }
                return;
              }
              await ConfirmDialog.show({
                title: 'Merge blocked',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Integration failed. The card was left in progress.',
                confirmText: 'OK',
                showCancelButton: false,
              });
              return;
            }
          }
        })();
        return;
      }

      commitMove();
    },
    [
      projectId,
      calculateSortOrder,
      statusColumnIndexMap,
      applyKanbanMove,
      issueMap,
      isManualSort,
      doneStatusIds,
      getWorkspacesForIssue,
      activeWorkspaces,
    ]
  );

  // Legacy list-view adapter (positional reorder still uses
  // hello-pangea). Translates the DropResult into a KanbanMove.
  const handleLegacyListDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination) return;
      const fromStatusId = result.source.droppableId;
      const toStatusId = result.destination.droppableId;
      if (
        fromStatusId === toStatusId &&
        result.source.index === result.destination.index
      ) {
        return;
      }
      handleKanbanMove({
        issueId: result.draggableId,
        fromStatusId,
        toStatusId,
        index: result.destination.index,
      });
    },
    [handleKanbanMove]
  );

  // Register the move-based handler with the SharedAppLayout bridge so the
  // shared DragProvider can delegate kanban-internal drops back here.
  //
  // The handler is registered ONCE on mount and reads the latest
  // `handleKanbanMove` through a ref. This is deliberate: handler identity
  // churns whenever `statuses` refetches via the ~30s fallback poll
  // (the chained `useMemo`s — `sortedStatuses` → `visibleStatuses` →
  // `statusColumnIndexMap` → `calculateSortOrder` — produce fresh
  // identities even for content-equal data), and re-registering on every
  // churn means the bridge cleanup nulls `kanbanHandlerRef.current` and
  // the next run sets it back. The ref pattern keeps the bridge handler
  // stable for the component's lifetime and always invokes the
  // freshest closure.
  const handleKanbanMoveRef = useRef(handleKanbanMove);
  handleKanbanMoveRef.current = handleKanbanMove;
  const { registerHandler: registerKanbanHandler } = useKanbanDragHandler();
  useEffect(() => {
    const stableHandler: KanbanDragHandler = (move) =>
      handleKanbanMoveRef.current(move);
    return registerKanbanHandler(stableHandler);
  }, [registerKanbanHandler]);

  // Multi-select support
  const {
    selectedIssueIds,
    isMultiSelectActive,
    handleIssueClick,
    handleCheckboxChange,
    clearSelection,
  } = useIssueMultiSelect();
  const setOrderedIssueIds = useIssueSelectionStore(
    (s) => s.setOrderedIssueIds
  );
  const setAnchor = useIssueSelectionStore((s) => s.setAnchor);

  // Compute ordered issue IDs for range selection
  const orderedIssueIds = useMemo(() => {
    const statusOrder =
      kanbanViewMode === 'kanban' ? visibleStatuses : listViewStatuses;
    return statusOrder.flatMap((status) => items[status.id] ?? []);
  }, [kanbanViewMode, visibleStatuses, listViewStatuses, items]);

  // Keep the store's ordered IDs in sync
  useEffect(() => {
    setOrderedIssueIds(orderedIssueIds);
  }, [orderedIssueIds, setOrderedIssueIds]);

  // Clear multi-selection when project or view mode changes
  useEffect(() => {
    clearSelection();
  }, [projectId, kanbanViewMode, clearSelection]);

  // Keep anchor in sync with the currently opened issue (e.g. from URL on
  // page load) so Shift/Cmd+Click on another issue includes it.
  useEffect(() => {
    if (selectedKanbanIssueId) {
      setAnchor(selectedKanbanIssueId);
    }
  }, [selectedKanbanIssueId, setAnchor]);

  const handleCardClick = useCallback(
    (issueId: string, e?: MouseEvent) => {
      if (e && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        handleIssueClick(issueId, e);
      } else {
        if (selectedIssueIds.size > 0) {
          clearSelection();
        }
        // Set as anchor so Shift+Click from this issue works
        setAnchor(issueId);
        openIssue(issueId);
      }
    },
    [
      openIssue,
      handleIssueClick,
      selectedIssueIds.size,
      clearSelection,
      setAnchor,
    ]
  );

  const handleAddTask = useCallback(
    (statusId?: string) => {
      const createPayload = {
        statusId: statusId ?? defaultCreateStatusId,
      };
      startCreate(createPayload);
    },
    [defaultCreateStatusId, startCreate]
  );

  // Inline editing callbacks for kanban cards
  // When multi-select is active, apply to all selected issues
  const handleCardPriorityClick = useCallback(
    (issueId: string) => {
      const ids = isMultiSelectActive ? [...selectedIssueIds] : [issueId];
      openPrioritySelection(projectId, ids);
    },
    [projectId, openPrioritySelection, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardMoreActionsClick = useCallback(
    (issueId: string) => {
      const ids = isMultiSelectActive ? [...selectedIssueIds] : [issueId];
      CommandBarDialog.show({
        page: 'issueActions',
        projectId,
        issueIds: ids,
      });
    },
    [projectId, selectedIssueIds, isMultiSelectActive]
  );

  const handleCardTagToggle = useCallback(
    (issueId: string, tagId: string) => {
      const currentIssueTags = getTagsForIssue(issueId);
      const existing = currentIssueTags.find((it) => it.tag_id === tagId);
      if (existing) {
        removeIssueTag(existing.id);
      } else {
        insertIssueTag({ issue_id: issueId, tag_id: tagId });
      }
    },
    [getTagsForIssue, insertIssueTag, removeIssueTag]
  );

  const getResolvedRelationshipsForIssue = useCallback(
    (issueId: string) =>
      resolveRelationshipsForIssue(
        issueId,
        getRelationshipsForIssue(issueId),
        issuesById
      ),
    [getRelationshipsForIssue, issuesById]
  );

  const handleCreateTag = useCallback(
    (data: { name: string; color: string }): string => {
      const { data: newTag } = insertTag({
        project_id: projectId,
        name: data.name,
        color: data.color,
      });
      return newTag.id;
    },
    [insertTag, projectId]
  );

  const isLoading = projectLoading;

  const breadcrumb = useMemo(
    () => buildProjectBreadcrumb(projects, projectId),
    [projects, projectId]
  );

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="flex flex-col h-full space-y-base">
      <div
        className={cn(
          'px-double pt-double space-y-base',
          isMobile && 'px-base pt-base'
        )}
      >
        <div className="flex items-center gap-half">
          <h2 className={cn('text-2xl font-medium', isMobile && 'text-lg')}>
            <ProjectBreadcrumb
              entries={breadcrumb}
              fallback={projectName}
              onNavigateProject={(id) => appNavigation.goToProject(id)}
            />
          </h2>

          <button
            type="button"
            onClick={() => toggleProjectTerminal()}
            className={cn(
              'p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors',
              isProjectTerminalOpen && 'text-normal bg-secondary'
            )}
            aria-label="Project terminal"
            title="Project terminal (Ctrl+Shift+`)"
          >
            <TerminalWindowIcon className="size-icon-sm" weight="bold" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                aria-label="Project menu"
              >
                <DotsThreeIcon className="size-icon-sm" weight="bold" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openProjectsGuide}>
                {t('kanban.openProjectsGuide', 'Projects guide')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => executeAction(Actions.ProjectSettings)}
              >
                {t('kanban.editProjectSettings', 'Edit project settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            'flex items-start gap-base',
            isMobile ? 'flex-col' : 'flex-wrap'
          )}
        >
          <ViewNavTabs
            activeView={kanbanViewMode}
            onViewChange={setKanbanViewMode}
            hiddenStatuses={hiddenStatuses}
            selectedStatusId={listViewStatusFilter}
            onStatusSelect={setListViewStatusFilter}
          />
          <KanbanFilterBar
            isFiltersDialogOpen={isFiltersDialogOpen}
            onFiltersDialogOpenChange={setIsFiltersDialogOpen}
            tags={tags}
            activeViewId={activeViewId}
            onViewChange={handleKanbanProjectViewChange}
            viewIds={KANBAN_PROJECT_VIEW_IDS}
            projectId={projectId}
            filters={kanbanFilters}
            showSubIssues={showSubIssues}
            showWorkspaces={showWorkspaces}
            hasActiveFilters={hasActiveFilters}
            onSearchQueryChange={setKanbanSearchQuery}
            onPrioritiesChange={setKanbanPriorities}
            onTagsChange={setKanbanTags}
            onSortChange={setKanbanSort}
            onShowSubIssuesChange={setShowSubIssues}
            onShowWorkspacesChange={setShowWorkspaces}
            hideBlocked={hideBlocked}
            onHideBlockedChange={setHideBlocked}
            onClearFilters={clearKanbanFilters}
            onCreateIssue={handleAddTask}
            shouldAnimateCreateButton={shouldAnimateCreateButton}
            renderFiltersDialog={(props) => <KanbanFiltersDialog {...props} />}
            isMobile={isMobile}
          />
          {!isMobile && (
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-half">
              <NewReleaseBadge />
              <AgentActivityIndicator projectId={projectId} />
            </div>
          )}
        </div>
      </div>

      {parentIssueId && (
        <div className="flex shrink-0 items-center gap-base border-b border-border px-double py-half">
          <button
            type="button"
            onClick={() =>
              appNavigation.goToProjectIssue(projectId, parentIssueId)
            }
            className="flex items-center gap-half rounded-sm p-half text-low hover:bg-secondary hover:text-normal transition-colors"
            aria-label={t('kanban.subIssueBoardBack')}
          >
            <ArrowLeftIcon className="size-icon-sm" weight="bold" />
          </button>
          <div className="flex min-w-0 items-center gap-half text-sm">
            <span className="shrink-0 text-low">{projectName}</span>
            <span className="shrink-0 text-low">/</span>
            <span className="shrink-0 font-ibm-plex-mono text-low">
              {issuesById.get(parentIssueId)?.simple_id ?? ''}
            </span>
            <span className="truncate text-normal">
              {issuesById.get(parentIssueId)?.title ??
                t('kanban.subIssueBoardTitle')}
            </span>
          </div>
        </div>
      )}

      {kanbanViewMode === 'kanban' ? (
        visibleStatuses.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-low">{t('kanban.noVisibleStatuses')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-x-auto px-double">
            <Profiler id="kanban-board" onRender={reportKanbanRender}>
              <KanbanProvider>
                {visibleStatuses.map((status) => {
                  const issueIds = items[status.id] ?? [];

                  return (
                    <Profiler
                      key={status.id}
                      id={`kanban-column-${status.id}`}
                      onRender={reportKanbanRender}
                    >
                      <KanbanBoard>
                        <KanbanHeader>
                          <div className="border-t sticky border-b top-0 z-20 flex shrink-0 items-center justify-between gap-2 p-base bg-secondary">
                            <div className="flex items-center gap-2">
                              <div
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{
                                  backgroundColor: `hsl(${status.color})`,
                                }}
                              />
                              <p className="m-0 text-sm">{status.name}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-flex items-center justify-center rounded-full bg-background border text-xs font-medium min-w-5 h-5 px-1.5 leading-none text-muted-foreground"
                                aria-label={`${issueIds.length} cards`}
                              >
                                {issueIds.length}
                              </span>
                              {!parentIssueId && (
                                <button
                                  type="button"
                                  onClick={() => handleAddTask(status.id)}
                                  className="p-half rounded-sm text-low hover:text-normal hover:bg-secondary transition-colors"
                                  aria-label="Add task"
                                >
                                  <PlusIcon
                                    className="size-icon-xs"
                                    weight="bold"
                                  />
                                </button>
                              )}
                            </div>
                          </div>
                        </KanbanHeader>
                        <KanbanCards
                          id={status.id}
                          activeProjectId={projectId}
                          issueIds={issueIds}
                          className="pt-base"
                          positionalReorderEnabled={isManualSort}
                        >
                          {issueIds.map((issueId) => {
                            const issue = issueMap[issueId];
                            if (!issue) return null;

                            return (
                              <KanbanIssueCard
                                key={issue.id}
                                issue={issue}
                                statusId={status.id}
                                projectId={projectId}
                                isMobile={isMobile}
                                isOpen={selectedKanbanIssueId === issue.id}
                                isSelected={selectedIssueIds.has(issue.id)}
                                dragDisabled={isMultiSelectActive}
                                issueWorkspaces={
                                  workspacesByIssueId.get(issue.id) ?? []
                                }
                                pullRequests={
                                  pullRequestsByIssueId.get(issue.id) ?? []
                                }
                                relationshipRecords={
                                  relationshipsByIssueId.get(issue.id) ?? []
                                }
                                issuesById={issuesById}
                                subIssueChildren={
                                  childrenByParentId.get(issue.id) ?? []
                                }
                                childWorkspacesByIssueId={workspacesByIssueId}
                                statusById={statusById}
                                tags={tags}
                                tagObjects={
                                  tagObjectsByIssueId.get(issue.id) ?? []
                                }
                                allIssueTagsByIssueId={issueTagsByIssueId}
                                dispatchWorkspaces={dispatchWorkspaces}
                                isSubIssuesExpanded={expandedSubIssueParents.has(
                                  issue.id
                                )}
                                onCardClick={handleCardClick}
                                onOpenIssue={openIssue}
                                onOpenWorkspace={openIssueWorkspace}
                                onToggleSubIssues={toggleSubIssuesExpanded}
                                onOpenSubBoard={openIssueSubBoard}
                                onPriorityClick={handleCardPriorityClick}
                                onMoreActionsClick={handleCardMoreActionsClick}
                                onInfoClick={openCardInfo}
                                onTagToggle={handleCardTagToggle}
                                onCreateTag={handleCreateTag}
                                onDispatch={handleDispatchIssueToWorkspace}
                              />
                            );
                          })}
                        </KanbanCards>
                      </KanbanBoard>
                    </Profiler>
                  );
                })}
              </KanbanProvider>
            </Profiler>
          </div>
        )
      ) : (
        <div className="flex-1 overflow-y-auto px-double">
          <KanbanProvider className="!block !w-full">
            <DragDropContext onDragEnd={handleLegacyListDragEnd}>
              <IssueListView
                statuses={listViewStatuses}
                items={items}
                issueMap={issueMap}
                getTagObjectsForIssue={getTagObjectsForIssue}
                getResolvedRelationshipsForIssue={
                  getResolvedRelationshipsForIssue
                }
                onIssueClick={handleCardClick}
                selectedIssueId={selectedKanbanIssueId}
                selectedIssueIds={selectedIssueIds}
                isMultiSelectActive={isMultiSelectActive}
                onIssueCheckboxChange={handleCheckboxChange}
              />
            </DragDropContext>
          </KanbanProvider>
        </div>
      )}

      {isMultiSelectActive && <BulkActionBarContainer projectId={projectId} />}

      {cardInfoIssueId && (
        <CardInfoDialog
          issueId={cardInfoIssueId}
          issueTitle={issueMap[cardInfoIssueId]?.title}
          open={cardInfoOpen}
          onOpenChange={setCardInfoOpen}
          loadMetrics={fetchIssueMetrics}
        />
      )}
    </div>
  );
}
