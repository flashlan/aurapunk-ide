import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { XIcon } from '@phosphor-icons/react';
import { SyncErrorProvider } from '@/shared/providers/SyncErrorProvider';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useUiPreferencesStore } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';

import { NavbarContainer } from './NavbarContainer';
import { Sidebar } from '@vibe/ui/components/Sidebar';
import { MobileDrawer } from '@vibe/ui/components/MobileDrawer';
import { SidebarBottomActions } from './SidebarBottomActions';
import { SidebarProjectTasksRegistry } from '@/shared/components/sidebar/SidebarProjectTasksRegistry';
import { Mem0SetupNotice } from '@/shared/components/Mem0SetupNotice';

import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  type ProjectTasksData,
  type OutlinerWorkspace,
  UNASSIGNED_PROJECT_ID,
} from '@vibe/ui/components/outliner/types';
import { getProjectDestination } from '@/shared/lib/routes/appNavigation';
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  CreateProjectDialog,
  type CreateProjectResult,
} from '@/shared/dialogs/CreateProjectDialog';
import { ProjectColorDialog } from '@/shared/dialogs/ProjectColorDialog';
import { CreateProjectButton } from './CreateProjectButton';
import { useCommandBarShortcut } from '@/shared/hooks/useCommandBarShortcut';
import { useShape } from '@/shared/integrations/electric/hooks';
import { useProjects } from '@/shared/hooks/useProjects';
import { ProjectProvider } from '@/shared/providers/ProjectProvider';
import {
  sortProjectsByOrder,
  swapProjectSiblings,
} from '@/shared/lib/projectOrder';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
  PROJECTS_SHAPE,
  type Project as RemoteProject,
} from 'shared/remote-types';
import { refreshShapeSource } from '@/shared/lib/electric/collections';
import { useWorkspaceProjectMembership } from '@/shared/hooks/useWorkspaceProjectMembership';
import { useWorkspaceContext } from '@/shared/hooks/useWorkspaceContext';
import { compareWorkspaceDashboardRecency } from '@/shared/lib/workspaceStatus/workspaceStatus';
import type { SidebarWorkspace } from '@/shared/hooks/useWorkspaces';
import { DragProvider, type DragCompletion } from '@vibe/ui/components/dnd';
import { resolveDragEnd } from '@/shared/lib/resolveDragEnd';
import {
  persistIssues,
  persistIssueSwap,
  persistProjectReorder,
} from '@/shared/lib/persistIssues';
import {
  buildIssueDragLookup,
  type IssueDragLookupRow,
} from '@/shared/lib/issueLookup';
import { useIssueSelectionStore } from '@/shared/stores/useIssueSelectionStore';
import {
  KanbanDragHandlerProvider,
  type KanbanDragHandler,
} from './KanbanDragHandlerContext';

export function SharedAppLayout() {
  const appNavigation = useAppNavigation();
  const currentDestination = useCurrentAppDestination();
  const { issueId: activeIssueId } = useCurrentKanbanRouteState();
  const isMobile = useIsMobile();
  const mobileFontScale = useUiPreferencesStore((s) => s.mobileFontScale);
  const isLeftSidebarVisible = useUiPreferencesStore(
    (s) => s.isLeftSidebarVisible
  );
  // Pinned mode: isLeftSidebarVisible === true means the sidebar is docked.
  // When false, the sidebar auto-hides and is revealed via a thin left-edge
  // hover strip with a slide animation.
  const isLeftSidebarPinned = isLeftSidebarVisible;
  const toggleLeftSidebarPinned = useUiPreferencesStore(
    (s) => s.toggleLeftSidebar
  );
  const [isSidebarHoverOpen, setIsSidebarHoverOpen] = useState(false);
  const hoverCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const openSidebarHover = useCallback(() => {
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
    setIsSidebarHoverOpen(true);
  }, []);
  const closeSidebarHoverDelayed = useCallback(() => {
    if (hoverCloseTimeoutRef.current)
      clearTimeout(hoverCloseTimeoutRef.current);
    hoverCloseTimeoutRef.current = setTimeout(
      () => setIsSidebarHoverOpen(false),
      120
    );
  }, []);
  const closeSidebarHoverImmediate = useCallback(() => {
    if (hoverCloseTimeoutRef.current) {
      clearTimeout(hoverCloseTimeoutRef.current);
      hoverCloseTimeoutRef.current = null;
    }
    setIsSidebarHoverOpen(false);
  }, []);
  useEffect(() => {
    if (isLeftSidebarPinned) setIsSidebarHoverOpen(false);
  }, [isLeftSidebarPinned]);
  useEffect(() => {
    return () => {
      if (hoverCloseTimeoutRef.current)
        clearTimeout(hoverCloseTimeoutRef.current);
    };
  }, []);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // `selectedIssueIds.size > 1` matches `useIssueMultiSelect`'s
  // `isMultiSelectActive` definition. We don't call the hook from web-core
  // here because it lives in web-core already — we just need the boolean
  // to gate tree card drag.
  const selectedIssueCount = useIssueSelectionStore(
    (s) => s.selectedIssueIds.size
  );
  const isMultiSelectActive = selectedIssueCount > 1;
  // Register CMD+K shortcut globally for all routes under SharedAppLayout
  useCommandBarShortcut(() => CommandBarDialog.show());

  // Apply mobile font scale CSS variable
  useEffect(() => {
    if (!isMobile) {
      document.documentElement.style.removeProperty('--mobile-font-scale');
      return;
    }
    const scaleMap = { default: '1', small: '0.9', smaller: '0.8' } as const;
    document.documentElement.style.setProperty(
      '--mobile-font-scale',
      scaleMap[mobileFontScale]
    );
    return () => {
      document.documentElement.style.removeProperty('--mobile-font-scale');
    };
  }, [isMobile, mobileFontScale]);

  // Sidebar state - projects (ADR-018: tenant-less, no org selection)
  const {
    data: projects = [],
    isLoading,
    update: updateProject,
    projectsById,
  } = useProjects();
  const sortedProjects = useMemo(
    () => sortProjectsByOrder(projects),
    [projects]
  );
  const [orderedProjects, setOrderedProjects] =
    useState<RemoteProject[]>(sortedProjects);
  // Collapse-by-default (2026-08-07): the per-project Tasks loaders run for
  // ALL live projects (see SidebarProjectTasksRegistry) so the open-task
  // count badges render while sections are collapsed. The previous
  // open-state-gated loader set is no longer needed.
  const [tasksByProject, setTasksByProject] = useState<
    ReadonlyMap<string, ProjectTasksData>
  >(() => new Map());
  const [loadingTasksProjectIds, setLoadingTasksProjectIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  useEffect(() => {
    setOrderedProjects(sortedProjects);
  }, [sortedProjects]);

  // Navigation state for the left sidebar.
  const projectDestination = useMemo(
    () => getProjectDestination(currentDestination),
    [currentDestination]
  );
  const activeProjectId = projectDestination?.projectId ?? null;
  // ADR-016: when the editor pane is open, light up the prompt row in
  // the tree (drives `aria-current` + the active styling). Always
  // piggy-backs on `projectDestination` — the editor is scoped to a
  // single project.
  const activeProjectPromptId =
    currentDestination?.kind === 'project-orchestrator-prompt'
      ? currentDestination.projectId
      : null;

  // Persist last selected project to scratch store
  const setSelectedProjectId = useUiPreferencesStore(
    (s) => s.setSelectedProjectId
  );
  useEffect(() => {
    if (activeProjectId) {
      setSelectedProjectId(activeProjectId);
    }
  }, [activeProjectId, setSelectedProjectId]);

  const handleTasksByProject = useCallback(
    (map: ReadonlyMap<string, ProjectTasksData>) => setTasksByProject(map),
    []
  );
  const handleLoadingTasks = useCallback(
    (projectIds: ReadonlySet<string>) => setLoadingTasksProjectIds(projectIds),
    []
  );
  const handleSelectIssue = useCallback(
    (projectId: string, issueId: string, parentIssueId?: string | null) => {
      // Clicking a sub-issue in the left pane opens it on its PARENT's board
      // (the sub-board route — the regular board filtered to the parent's
      // children), so the user sees the sub-issue in context with its
      // siblings. A top-level issue opens its own panel on the main board.
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
    [appNavigation]
  );

  const handleProjectClick = useCallback(
    (projectId: string) => {
      appNavigation.goToProject(projectId);
    },
    [appNavigation]
  );

  // Collapse-by-default (2026-08-07): the Workspaces section's open-page icon
  // opens the workspaces dashboard scoped to that project. The Unassigned
  // pseudo-project opens the unfiltered (all-workspaces) dashboard.
  const setWorkspacesDashboardProjectId = useUiPreferencesStore(
    (s) => s.setWorkspacesDashboardProjectId
  );
  const handleOpenWorkspacesPage = useCallback(
    (projectId: string) => {
      setWorkspacesDashboardProjectId(
        projectId === UNASSIGNED_PROJECT_ID ? null : projectId
      );
      appNavigation.goToWorkspaces();
    },
    [appNavigation, setWorkspacesDashboardProjectId]
  );

  // ADR-016: open the per-project orchestrator-prompt editor pane.
  // Triggered by the sidebar tree's `+` menu item and the prompt row's
  // click. The editor IS the page (sidebar mode: 'closed').
  const handleSelectOrchestratorPrompt = useCallback(
    (projectId: string) => {
      appNavigation.goToProjectOrchestratorPrompt(projectId);
    },
    [appNavigation]
  );

  const handleCreateProject = useCallback(async () => {
    try {
      const result: CreateProjectResult = await CreateProjectDialog.show({});

      if (result.action === 'created' && result.project) {
        appNavigation.goToProject(result.project.id);
      }
    } catch {
      // Dialog cancelled — no-op.
    }
  }, [appNavigation]);

  // ADR-015: open the project-create dialog with `parentId` set so the new
  // project is created as a child board of the supplied project id. The
  // returned project is the child (regardless of depth), so navigation
  // targets the child's kanban directly.
  const handleCreateChildBoard = useCallback(
    async (parentId: string) => {
      try {
        const result: CreateProjectResult = await CreateProjectDialog.show({
          parentId,
        });

        if (result.action === 'created' && result.project) {
          appNavigation.goToProject(result.project.id);
        }
      } catch {
        // Dialog cancelled — no-op.
      }
    },
    [appNavigation]
  );

  const projectsByIdRef = useRef(projectsById);
  projectsByIdRef.current = projectsById;

  // Force the projects shape to re-fetch after a direct REST delete (the
  // delete went around the collection mutation, which normally refreshes).
  const refreshProjectsShape = useCallback(() => {
    refreshShapeSource(PROJECTS_SHAPE, {});
  }, []);

  // Rename a project from the sidebar `+` menu. The backend keeps the
  // project key stable on rename (issue IDs like `TEST-1` do not change).
  const handleRenameProject = useCallback(
    async (projectId: string) => {
      const project = projectsByIdRef.current.get(projectId);
      const currentName = project?.name ?? '';
      const newName = window.prompt('Rename project', currentName);
      if (newName === null) return; // cancelled
      const trimmed = newName.trim();
      if (!trimmed || trimmed === currentName) return;
      try {
        await updateProject(projectId, { name: trimmed });
      } catch {
        // Swallow — the shape collection surfaces errors via the row state.
      }
    },
    [updateProject]
  );

  // Change a project's color from the sidebar `+` menu. The color tints the
  // project row and its whole subtree (sections, workspaces, tasks, cards).
  const handleChangeProjectColor = useCallback(
    async (projectId: string) => {
      const project = projectsByIdRef.current.get(projectId);
      if (!project) return;
      try {
        await ProjectColorDialog.show({
          projectName: project.name,
          currentColor: project.color,
          onSave: async (color) => {
            await updateProject(projectId, { color });
          },
        });
      } catch {
        // Dialog cancelled — no-op.
      }
    },
    [updateProject]
  );

  // Archive a project from the sidebar `+` menu. Safer than deleting: the
  // board leaves the sidebar, becomes read-only, and keeps its history until
  // it is permanently deleted from the Archived section.
  const handleArchiveProject = useCallback(
    async (projectId: string) => {
      const project = projectsByIdRef.current.get(projectId);
      const name = project?.name ?? projectId;
      const result = await ConfirmDialog.show({
        title: 'Archive project?',
        message: `"${name}" will be moved to Archived and become read-only. You can restore it at any time.`,
        confirmText: 'Archive',
        variant: 'info',
      });
      if (result !== 'confirmed') return;
      try {
        await updateProject(projectId, { archived: true });
        if (activeProjectId === projectId) {
          appNavigation.goToWorkspaces();
        }
      } catch {
        // Swallow — the shape collection surfaces errors via the row state.
      }
    },
    [updateProject, appNavigation, activeProjectId]
  );

  const handleRestoreProject = useCallback(
    async (projectId: string) => {
      try {
        await updateProject(projectId, { archived: false });
      } catch {
        // Swallow — the shape collection surfaces errors via the row state.
      }
    },
    [updateProject]
  );

  // Permanently delete an ARCHIVED project from the Archived section.
  // Cascades to the project's issues, statuses, tags, and links.
  const handleDeleteArchivedProject = useCallback(
    async (projectId: string) => {
      const project = projectsByIdRef.current.get(projectId);
      const name = project?.name ?? projectId;
      const result = await ConfirmDialog.show({
        title: 'Delete archived project?',
        message: `"${name}" and all of its issues, statuses, and tags will be permanently deleted. This cannot be undone.`,
        confirmText: 'Delete',
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;

      // Ask whether the on-disk worktrees/branches of the project's workspaces
      // should be removed too (otherwise they stay as orphaned dirs in the
      // workspace folder).
      const cleanupWs = await ConfirmDialog.show({
        title: 'Delete workspaces on disk too?',
        message: `Remove the workspace folders and git branches created for "${name}" from disk? The app database rows are deleted either way; this only affects the files on disk.`,
        confirmText: 'Delete on disk',
        cancelText: 'Keep on disk',
        variant: 'destructive',
      });

      try {
        const response = await fetch(
          `/v1/projects/${projectId}${
            cleanupWs === 'confirmed' ? '?cleanup_workspaces=true' : ''
          }`,
          { method: 'DELETE' }
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(body.message || 'Failed to delete project');
        }
        refreshProjectsShape();
        if (activeProjectId === projectId) {
          appNavigation.goToWorkspaces();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to delete project. It may have child boards.';
        await ConfirmDialog.show({
          title: 'Could not delete project',
          message,
          confirmText: 'OK',
          showCancelButton: false,
          variant: 'info',
        });
      }
    },
    [appNavigation, activeProjectId]
  );

  // ADR-007: project reorder is disabled tree-wide (see PLAN-sidebar-kanban-cross-dnd);
  // project order is set by the sorted-projects effect below only.

  // ---------------------------------------------------------------------
  // Cross-surface drag-and-drop (ADR-012)
  // ---------------------------------------------------------------------
  //
  // `<DragProvider>` mounts here so its `DragController` can resolve a
  // single drag between the sidebar tree (sidebar contains
  // SidebarProjectTree) and the kanban board (Outlet: KanbanContainer).
  // `resolveDragEnd` classifies each drop; the kanban-internal path
  // delegates to the handler registered through
  // KanbanDragHandlerContext, while cross-surface / tree-internal moves
  // fire `bulkUpdateIssues` directly.
  //
  // `activeProjectId` and `issuesById` are read as values (not closures
  // over stale state) so each render gets a fresh dep array.
  const kanbanHandlerRef = useRef<KanbanDragHandler | null>(null);
  const registerKanbanHandler = useCallback((handler: KanbanDragHandler) => {
    kanbanHandlerRef.current = handler;
    return () => {
      kanbanHandlerRef.current = null;
    };
  }, []);
  const providerValue = useMemo(
    () => ({ registerHandler: registerKanbanHandler }),
    [registerKanbanHandler]
  );

  // Subscribe the active project's issues for the DnD resolver. The
  // shape collection dedupes with the kanban's ProjectProvider, so this
  // doesn't add network cost — it just lifts the project→id index up so
  // resolveDragEnd can verify the source issue and disambiguate
  // bare-UUID kanban columns from card targets.
  const activeProjectParams = useMemo<Record<string, string>>(
    () =>
      activeProjectId
        ? { project_id: activeProjectId as string }
        : ({ project_id: '' } as Record<string, string>),
    [activeProjectId]
  );
  const activeProjectIssues = useShape(
    PROJECT_ISSUES_SHAPE,
    activeProjectParams,
    {
      enabled: Boolean(activeProjectId),
    }
  );
  const activeProjectStatuses = useShape(
    PROJECT_PROJECT_STATUSES_SHAPE,
    activeProjectParams,
    {
      enabled: Boolean(activeProjectId),
    }
  );
  const issuesById = useMemo(() => {
    if (!activeProjectId) return new Map<string, IssueDragLookupRow>();
    return buildIssueDragLookup(activeProjectIssues.data, activeProjectId);
  }, [activeProjectIssues.data, activeProjectId]);
  // The active project's visible status-id set. The resolver threads
  // this through to `resolveDragEnd` so a stale `data-drop-target-id`
  // attr pointing at a deleted status is rejected instead of routing
  // a move into a `status_id` that no longer exists.
  const statusIds = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    if (!activeProjectId) return set;
    for (const status of activeProjectStatuses.data) {
      set.add(status.id);
    }
    return set;
  }, [activeProjectStatuses.data, activeProjectId]);

  // Latest-value refs for the cross-surface handler. Reading
  // activeProjectId / issuesById / statusIds through refs (not
  // useCallback deps) keeps the handler identity STABLE across renders.
  const dndContextRef = useRef({
    activeProjectId,
    issuesById,
    statusIds,
  });
  dndContextRef.current = {
    activeProjectId,
    issuesById,
    statusIds,
  };

  // Mirror of orderedProjects as a ref so the drag-end callback reads
  // the live post-swap state without re-creating the callback when
  // orderedProjects changes.
  const orderedProjectsRef = useRef(orderedProjects);
  orderedProjectsRef.current = orderedProjects;

  const handleCrossSurfaceDragEnd = useCallback(
    (completion: DragCompletion) => {
      const {
        activeProjectId: projectId,
        issuesById: byId,
        statusIds: statusIdsForResolve,
      } = dndContextRef.current;
      const outcome = resolveDragEnd(
        completion,
        projectId,
        byId,
        statusIdsForResolve
      );
      switch (outcome.type) {
        case 'no-op':
          return;
        case 'invalid':
          // Snap-back is automatic when no state change fires; console
          // for now so devs see why a drop was rejected during smoke.
          console.debug('[dnd] drop rejected:', outcome.reason);
          return;
        case 'kanban-internal':
          kanbanHandlerRef.current?.({
            issueId: outcome.issueId,
            fromStatusId: outcome.fromStatusId,
            toStatusId: outcome.toStatusId,
            index: outcome.index ?? undefined,
          });
          return;
        case 'issue-swap': {
          const sourceIssue = byId.get(outcome.sourceIssueId);
          const targetIssue = byId.get(outcome.targetIssueId);
          if (!sourceIssue || !targetIssue) return;
          if (sourceIssue.status_id !== targetIssue.status_id) {
            if (kanbanHandlerRef.current) {
              kanbanHandlerRef.current({
                issueId: sourceIssue.id,
                fromStatusId: sourceIssue.status_id,
                toStatusId: targetIssue.status_id,
              });
              return;
            }
            persistIssues(
              [
                {
                  id: sourceIssue.id,
                  changes: {
                    status_id: targetIssue.status_id,
                    allow_unmerged_done: true,
                  },
                },
              ],
              outcome.projectId,
              {
                onError: (err) =>
                  console.error('[dnd] cross-surface move failed:', err),
              }
            );
            return;
          }
          if (kanbanHandlerRef.current) {
            kanbanHandlerRef.current({
              issueId: sourceIssue.id,
              fromStatusId: sourceIssue.status_id,
              toStatusId: targetIssue.status_id,
              swapWithIssueId: targetIssue.id,
            });
            return;
          }
          persistIssueSwap(sourceIssue, targetIssue, outcome.projectId, {
            onError: (err) => console.error('[dnd] kanban swap failed:', err),
          });
          return;
        }
        case 'move-issue':
          persistIssues(
            [
              {
                id: outcome.issueId,
                changes: { status_id: outcome.targetStatusId },
              },
            ],
            outcome.projectId,
            {
              onError: (err) =>
                console.error(
                  '[dnd] cross-surface move failed:',
                  err,
                  'issue',
                  outcome.issueId,
                  '→ status',
                  outcome.targetStatusId
                ),
            }
          );
          return;
        case 'project-reorder': {
          const aId = outcome.projectId;
          const bId = outcome.targetProjectId;
          const cur = orderedProjectsRef.current;
          const a = cur.find((p) => p.id === aId);
          const b = cur.find((p) => p.id === bId);
          // F-8: cross-parent reorder is out of scope (DnD's
          // `collectTargets` sibling filter currently screens this, but
          // a future relaxed filter would otherwise flow into a no-op
          // optimistic update + wasted DB write). Bail before the swap.
          if (!a || !b || (a.parent_id ?? null) !== (b.parent_id ?? null)) {
            return;
          }
          const swappedAll = swapProjectSiblings(cur, aId, bId);
          // Belt-and-suspenders: `swapProjectSiblings` always returns a
          // fresh array (see `projectOrder.test.ts`), so this identity
          // check is currently dead. Kept so a future change to its
          // contract (return-on-no-op) keeps the no-op behaviour intact.
          if (swappedAll === cur) return;
          orderedProjectsRef.current = swappedAll;
          setOrderedProjects(swappedAll);
          // ADR-013 / F-7: persist ONLY the swapped sibling group, not the
          // whole project list. Reassigning every project's sort_order
          // would rewrite unrelated sibling groups (other parents'
          // children) with a fresh i*STEP ladder and drift them away
          // from what the user actually moved. Slice to siblings of the
          // swapped pair's shared parent.
          const parentId =
            swappedAll.find((p) => p.id === aId)?.parent_id ?? null;
          const siblingGroup = swappedAll.filter(
            (p) => (p.parent_id ?? null) === parentId
          );
          // Renumber the sibling group's sort_order to a fresh ladder
          // (i*STEP). The default sort_order=0 on every project makes a
          // pairwise swap a no-op under the created_at tiebreak in
          // `sortProjectsByOrder`; rewriting just this group's rows
          // normalises the field and lets the tiebreak yield to the
          // swap. (P4-D3.)
          // ADR-018 — projects are tenant-less, no orgId param.
          persistProjectReorder(siblingGroup, {
            onError: (err) =>
              console.error(
                '[dnd] project reorder failed:',
                err,
                aId,
                '↔',
                bId
              ),
          });
          return;
        }
      }
    },
    []
  );

  // Workspace tree data: derive membership from the remote-shape workspaces
  // exposed by WorkspacesContext, then surface active/archived lists from the
  // local workspace context so the tree stays in sync with live status.
  const membership = useWorkspaceProjectMembership();
  const {
    workspaceId,
    activeWorkspaces,
    archivedWorkspaces,
    isWorkspacesListLoading,
  } = useWorkspaceContext();
  const workspaceColors = useUiPreferencesStore((s) => s.workspaceColors);

  const sidebarProjects = useMemo(
    () =>
      orderedProjects
        .filter((p) => !p.archived)
        .map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          parentId: p.parent_id ?? null,
          sortOrder: p.sort_order,
          // ADR-016: mirror wire `has_orchestrator_prompt` so the tree's
          // brand-coloured dot tracks the row on every refresh. The body
          // never ships on the list shape — the editor's `resolve` GET
          // fetches the resolved value with provenance.
          hasOrchestratorPrompt: p.has_orchestrator_prompt,
        })),
    [orderedProjects]
  );
  const archivedSidebarProjects = useMemo(
    () =>
      orderedProjects
        .filter((p) => p.archived)
        .map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          parentId: p.parent_id ?? null,
          sortOrder: p.sort_order,
          hasOrchestratorPrompt: p.has_orchestrator_prompt,
        })),
    [orderedProjects]
  );
  const realProjectIds = useMemo(
    () => sidebarProjects.map((project) => project.id),
    [sidebarProjects]
  );

  // Single mapper used by both active and archived OutlinerWorkspace memos.
  // SidebarWorkspace is the union element type for both source arrays.
  const toOutlinerWorkspace = (ws: SidebarWorkspace): OutlinerWorkspace => ({
    id: ws.id,
    name: ws.name,
    color: workspaceColors[ws.id],
    createdAt: ws.createdAt,
    filesChanged: ws.filesChanged,
    linesAdded: ws.linesAdded,
    linesRemoved: ws.linesRemoved,
    isRunning: ws.isRunning,
    isPinned: ws.isPinned,
    kind: ws.kind,
    hasPendingApproval: ws.hasPendingApproval,
    hasRunningDevServer: ws.hasRunningDevServer,
    hasUnseenActivity: ws.hasUnseenActivity,
    latestProcessCompletedAt: ws.latestProcessCompletedAt,
    latestProcessStatus: ws.latestProcessStatus,
    prStatus: ws.prStatus,
  });

  const outlinerWorkspaces = useMemo<OutlinerWorkspace[]>(
    () => activeWorkspaces.map(toOutlinerWorkspace),
    [activeWorkspaces, workspaceColors]
  );

  const outlinerArchivedWorkspaces = useMemo<OutlinerWorkspace[]>(
    () => archivedWorkspaces.map(toOutlinerWorkspace),
    [archivedWorkspaces, workspaceColors]
  );

  // Orchestrator ⚡ icon: open the most-recent workspace under the
  // Orchestrator (Unassigned) pseudo-project directly from the top-level row,
  // skipping the expand → Workspaces → bucket drill-down. Prefers active
  // workspaces, falls back to archived; sorts by dashboard recency.
  const handleOpenLastOrchestratorWorkspace = useCallback(() => {
    const isUnassignedWs = (ws: OutlinerWorkspace) =>
      !(membership.get(ws.id)?.size ?? 0);
    const candidates = [
      ...outlinerWorkspaces.filter(isUnassignedWs),
      ...outlinerArchivedWorkspaces.filter(isUnassignedWs),
    ];
    if (candidates.length === 0) return;
    const sorted = [...candidates].sort(compareWorkspaceDashboardRecency);
    const last = sorted[0];
    if (last) appNavigation.goToWorkspace(last.id);
  }, [
    outlinerWorkspaces,
    outlinerArchivedWorkspaces,
    membership,
    appNavigation,
  ]);

  return (
    <SyncErrorProvider>
      <DragProvider onDrop={handleCrossSurfaceDragEnd}>
        <KanbanDragHandlerProvider value={providerValue}>
          <SidebarProjectTasksRegistry
            projectIds={realProjectIds}
            onTasksByProject={handleTasksByProject}
            onLoadingTasksProjectIds={handleLoadingTasks}
          />
          <ProjectProvider>
            <div
              className={cn(
                'bg-primary',
                isMobile
                  ? 'flex fixed inset-0 pb-[env(safe-area-inset-bottom)]'
                  : cn(
                      'grid grid-rows-[minmax(0,1fr)] h-screen',
                      isLeftSidebarPinned
                        ? 'grid-cols-[256px_1fr]'
                        : 'grid-cols-[1fr]'
                    )
              )}
            >
              {!isMobile && (
                <>
                  {/* Pinned: sidebar occupies its grid column. Unpinned:
                      sidebar is hidden and revealed via a thin left-edge
                      hover strip — slide animation via translate-x. */}
                  {isLeftSidebarPinned ? (
                    <Sidebar
                      projects={sidebarProjects}
                      activeProjectId={activeProjectId}
                      activeProjectPromptId={activeProjectPromptId}
                      activeWorkspaceId={workspaceId ?? null}
                      activeIssueId={activeIssueId}
                      tasksByProject={tasksByProject}
                      loadingTasksProjectIds={loadingTasksProjectIds}
                      onSelectIssue={handleSelectIssue}
                      workspaces={outlinerWorkspaces}
                      archivedWorkspaces={outlinerArchivedWorkspaces}
                      membership={membership}
                      isLoadingProjects={isLoading}
                      isLoadingWorkspaces={isWorkspacesListLoading}
                      onSelectWorkspace={(id) =>
                        appNavigation.goToWorkspace(id)
                      }
                      onOpenProjectPage={handleProjectClick}
                      onOpenWorkspacesPage={handleOpenWorkspacesPage}
                      onOpenLastWorkspace={handleOpenLastOrchestratorWorkspace}
                      onSelectOrchestratorPrompt={
                        handleSelectOrchestratorPrompt
                      }
                      onCreateChildBoard={handleCreateChildBoard}
                      onRenameProject={handleRenameProject}
                      onChangeProjectColor={handleChangeProjectColor}
                      onArchiveProject={handleArchiveProject}
                      archivedProjects={archivedSidebarProjects}
                      onRestoreProject={handleRestoreProject}
                      onDeleteArchivedProject={handleDeleteArchivedProject}
                      isMultiSelectActive={isMultiSelectActive}
                      isPinned={true}
                      onTogglePinned={toggleLeftSidebarPinned}
                      headerActions={
                        <CreateProjectButton onClick={handleCreateProject} />
                      }
                      bottomActions={<SidebarBottomActions />}
                    />
                  ) : (
                    <>
                      {/* Thin vertical hover strip at the extreme left edge */}
                      <div
                        aria-hidden="true"
                        onMouseEnter={openSidebarHover}
                        className="group fixed left-0 top-0 bottom-0 z-20 flex w-[10px] cursor-pointer items-stretch justify-center"
                      >
                        <div className="w-px bg-border/40 transition-all duration-200 group-hover:w-[3px] group-hover:bg-brand/60" />
                      </div>
                      {/* Overlay backdrop when expanded */}
                      {isSidebarHoverOpen && (
                        <div
                          className="fixed inset-0 z-20 bg-black/10 backdrop-blur-[1px] animate-in fade-in duration-200"
                          onClick={closeSidebarHoverImmediate}
                          aria-hidden="true"
                        />
                      )}
                      <div
                        onMouseEnter={openSidebarHover}
                        onMouseLeave={closeSidebarHoverDelayed}
                        className={cn(
                          'fixed left-0 top-0 bottom-0 z-30 w-[256px] overflow-hidden border-r border-border shadow-2xl',
                          'transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] will-change-transform',
                          isSidebarHoverOpen
                            ? 'translate-x-0'
                            : '-translate-x-full'
                        )}
                      >
                        <Sidebar
                          projects={sidebarProjects}
                          activeProjectId={activeProjectId}
                          activeProjectPromptId={activeProjectPromptId}
                          activeWorkspaceId={workspaceId ?? null}
                          activeIssueId={activeIssueId}
                          tasksByProject={tasksByProject}
                          loadingTasksProjectIds={loadingTasksProjectIds}
                          onSelectIssue={handleSelectIssue}
                          workspaces={outlinerWorkspaces}
                          archivedWorkspaces={outlinerArchivedWorkspaces}
                          membership={membership}
                          isLoadingProjects={isLoading}
                          isLoadingWorkspaces={isWorkspacesListLoading}
                          onSelectWorkspace={(id) => {
                            appNavigation.goToWorkspace(id);
                            closeSidebarHoverImmediate();
                          }}
                          onOpenProjectPage={(id) => {
                            handleProjectClick(id);
                            closeSidebarHoverImmediate();
                          }}
                          onOpenWorkspacesPage={(pid) => {
                            handleOpenWorkspacesPage(pid);
                            closeSidebarHoverImmediate();
                          }}
                          onOpenLastWorkspace={() => {
                            handleOpenLastOrchestratorWorkspace();
                            closeSidebarHoverImmediate();
                          }}
                          onSelectOrchestratorPrompt={(id) => {
                            handleSelectOrchestratorPrompt(id);
                            closeSidebarHoverImmediate();
                          }}
                          onCreateChildBoard={handleCreateChildBoard}
                          onRenameProject={handleRenameProject}
                          onChangeProjectColor={handleChangeProjectColor}
                          onArchiveProject={handleArchiveProject}
                          archivedProjects={archivedSidebarProjects}
                          onRestoreProject={handleRestoreProject}
                          onDeleteArchivedProject={handleDeleteArchivedProject}
                          isMultiSelectActive={isMultiSelectActive}
                          isPinned={false}
                          onTogglePinned={toggleLeftSidebarPinned}
                          className="h-full w-full"
                          headerActions={
                            <CreateProjectButton
                              onClick={handleCreateProject}
                            />
                          }
                          bottomActions={<SidebarBottomActions />}
                        />
                      </div>
                    </>
                  )}
                  {/* Content column: Navbar on top, Outlet below. */}
                  <div className="flex flex-col min-h-0 min-w-0">
                    <NavbarContainer
                      onOpenDrawer={() => setIsDrawerOpen(true)}
                    />
                    <Mem0SetupNotice />
                    <div className="relative flex-1 min-h-0 overflow-hidden">
                      <Outlet />
                    </div>
                  </div>
                </>
              )}

              {isMobile && (
                <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
                  <NavbarContainer
                    mobileMode={isMobile}
                    onOpenDrawer={() => setIsDrawerOpen(true)}
                  />
                  <Mem0SetupNotice />
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <Outlet />
                  </div>
                </div>
              )}

              {/* Mobile project navigation drawer (rebuilt on the same Sidebar
            primitives). */}
              <MobileDrawer
                open={isDrawerOpen && isMobile}
                onClose={() => setIsDrawerOpen(false)}
              >
                <div className="flex flex-col h-full">
                  {/* Header: drawer close button. ADR-018 — no org name display. */}
                  <div className="flex items-center justify-end p-4 border-b border-border">
                    <button
                      type="button"
                      onClick={() => setIsDrawerOpen(false)}
                      className="p-1 rounded-sm text-low hover:text-normal cursor-pointer"
                      aria-label="Close"
                    >
                      <XIcon className="h-4 w-4" weight="bold" />
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <Sidebar
                      projects={sidebarProjects}
                      activeProjectId={activeProjectId}
                      activeProjectPromptId={activeProjectPromptId}
                      activeWorkspaceId={workspaceId ?? null}
                      activeIssueId={activeIssueId}
                      tasksByProject={tasksByProject}
                      loadingTasksProjectIds={loadingTasksProjectIds}
                      onSelectIssue={handleSelectIssue}
                      workspaces={outlinerWorkspaces}
                      archivedWorkspaces={outlinerArchivedWorkspaces}
                      membership={membership}
                      isLoadingProjects={isLoading}
                      isLoadingWorkspaces={isWorkspacesListLoading}
                      onSelectWorkspace={(id) =>
                        appNavigation.goToWorkspace(id)
                      }
                      onOpenProjectPage={(id) => {
                        handleProjectClick(id);
                        setIsDrawerOpen(false);
                      }}
                      onOpenWorkspacesPage={(projectId) => {
                        handleOpenWorkspacesPage(projectId);
                        setIsDrawerOpen(false);
                      }}
                      onOpenLastWorkspace={() => {
                        handleOpenLastOrchestratorWorkspace();
                        setIsDrawerOpen(false);
                      }}
                      onSelectOrchestratorPrompt={(id) => {
                        handleSelectOrchestratorPrompt(id);
                        setIsDrawerOpen(false);
                      }}
                      onCreateChildBoard={handleCreateChildBoard}
                      onRenameProject={(id) => {
                        void handleRenameProject(id);
                        setIsDrawerOpen(false);
                      }}
                      onChangeProjectColor={(id) => {
                        void handleChangeProjectColor(id);
                        setIsDrawerOpen(false);
                      }}
                      onArchiveProject={(id) => {
                        void handleArchiveProject(id);
                        setIsDrawerOpen(false);
                      }}
                      archivedProjects={archivedSidebarProjects}
                      onRestoreProject={handleRestoreProject}
                      onDeleteArchivedProject={handleDeleteArchivedProject}
                      isMultiSelectActive={isMultiSelectActive}
                      headerActions={
                        <CreateProjectButton onClick={handleCreateProject} />
                      }
                      bottomActions={<SidebarBottomActions />}
                    />
                  </div>
                </div>
              </MobileDrawer>
            </div>
          </ProjectProvider>
        </KanbanDragHandlerProvider>
      </DragProvider>
    </SyncErrorProvider>
  );
}
