import { useId, type ReactNode } from 'react';
import { ArrowClockwiseIcon, TrashIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { SidebarBar } from './SidebarBar';
import { SidebarBucketBar } from './SidebarBucketBar';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { SidebarSeparator } from './SidebarSeparator';
import { SidebarProjectTree } from './SidebarProjectTree';
import type { ProjectTasksData } from './outliner/types';
import type { SidebarProject } from './outliner/types';
import type {
  OutlinerWorkspace,
  WorkspaceProjectMembership,
} from './outliner/types';

export type { WorkspaceProjectMembership } from './outliner/types';

interface SidebarProps {
  /** All active (non-archived) projects to render at the root of the tree. */
  projects: readonly SidebarProject[];
  /** Archived (read-only) projects, shown in a separate section below the tree. */
  archivedProjects?: readonly SidebarProject[];
  /** Restores an archived project back to the main tree. */
  onRestoreProject?: (projectId: string) => void;
  /** Permanently deletes an archived project (cascades issues/statuses/tags). */
  onDeleteArchivedProject?: (projectId: string) => void;
  /** Project id whose destination the user is currently on, if any. */
  activeProjectId: string | null;
  /** Active (non-archived) workspaces, fed into each project's tree. */
  workspaces: OutlinerWorkspace[];
  /** Archived workspaces. */
  archivedWorkspaces?: OutlinerWorkspace[];
  /** local_workspace_id → set of project ids (for tree grouping). */
  membership: WorkspaceProjectMembership;
  /** Workspace id whose destination the user is currently on, if any. */
  activeWorkspaceId: string | null;
  tasksByProject?: ReadonlyMap<string, ProjectTasksData>;
  loadingTasksProjectIds?: ReadonlySet<string>;
  activeIssueId?: string | null;
  onTasksExpansionChange?: (projectId: string, isOpen: boolean) => void;
  onSelectIssue?: (
    projectId: string,
    issueId: string,
    parentIssueId?: string | null
  ) => void;
  isLoadingProjects?: boolean;
  isLoadingWorkspaces?: boolean;
  onSelectWorkspace: (id: string) => void;
  /** Collapse-by-default (2026-08-07): opens the project's kanban board when
   *  the open-page icon is clicked on a project row or Tasks section. Row
   *  clicks toggle expand/collapse. */
  onOpenProjectPage?: (projectId: string) => void;
  /** Opens the flat workspaces dashboard when the open-page icon is clicked
   *  on a Workspaces section row. */
  onOpenWorkspacesPage?: (projectId: string) => void;
  /** Opens the most-recent workspace under the Orchestrator (Unassigned)
   *  pseudo-project when its ⚡ icon is clicked. */
  onOpenLastWorkspace?: () => void;
  /** ADR-015: opens `CreateRemoteProjectDialog` with `parentId` set so the
   *  new project is created as a child board of the supplied project id. */
  onCreateChildBoard?: (parentId: string) => void;
  /** ADR-016: opens the per-project orchestrator-prompt editor pane.
   *  Triggered by the tree's `+` menu item and the prompt row's click. */
  onSelectOrchestratorPrompt?: (projectId: string) => void;
  /** Renames the supplied project (sidebar `+` menu → Rename). */
  onRenameProject?: (projectId: string) => void;
  /** Opens the color editor for the supplied project (sidebar `+` menu →
   *  Change color). */
  onChangeProjectColor?: (projectId: string) => void;
  /** Archives the supplied project (sidebar `+` menu → Archive). Archived
   *  boards leave the tree, become read-only, and keep their history. */
  onArchiveProject?: (projectId: string) => void;
  /** ADR-016: project id whose prompt editor is currently open. Drives
   *  the rendered row's `aria-current` and active styling. */
  activeProjectPromptId?: string | null;

  /** When >1 issues are selected, disable card drag-and-drop in the tree.
   * Mirrors KanbanCard's `dragDisabled={isMultiSelectActive}` (PLAN §7.5). */
  isMultiSelectActive?: boolean;

  /** Right-aligned actions for the Projects section header (e.g. create-project button). */
  headerActions?: ReactNode;
  /** Bottom bar content (e.g. Notifications / Settings buttons), rendered in
   *  a shared SidebarBar pinned to the bottom. */
  bottomActions?: ReactNode;
  className?: string;
  /** Pin/lock control for the left sidebar — mirrors ToggleLeftSidebar as a pinned flag. */
  isPinned?: boolean;
  onTogglePinned?: () => void;
}

export function Sidebar({
  projects,
  archivedProjects = [],
  onRestoreProject,
  onDeleteArchivedProject,
  activeProjectId,
  activeProjectPromptId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  tasksByProject,
  loadingTasksProjectIds,
  activeIssueId,
  onTasksExpansionChange,
  onSelectIssue,
  isLoadingProjects,
  isLoadingWorkspaces,
  onSelectWorkspace,
  onOpenProjectPage,
  onOpenWorkspacesPage,
  onOpenLastWorkspace,
  onCreateChildBoard,
  onSelectOrchestratorPrompt,
  onRenameProject,
  onChangeProjectColor,
  onArchiveProject,
  isMultiSelectActive,
  headerActions,
  bottomActions,
  className,
  isPinned,
  onTogglePinned,
}: SidebarProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  return (
    <aside
      aria-label="Primary sidebar"
      className={cn(
        'flex h-full w-[256px] shrink-0 flex-col gap-2 overflow-hidden',
        'border-r border-border bg-secondary px-2 pt-2 pb-2',
        className
      )}
    >
      <SidebarBucketBar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={onSelectWorkspace}
        isPinned={isPinned}
        onTogglePinned={onTogglePinned}
      />

      <SidebarSeparator />

      <SidebarSectionHeader
        title={t('appBar.projects')}
        titleId={titleId}
        actions={headerActions}
      />

      <SidebarProjectTree
        projects={projects}
        activeProjectId={activeProjectId}
        activeProjectPromptId={activeProjectPromptId}
        workspaces={workspaces}
        archivedWorkspaces={archivedWorkspaces}
        membership={membership}
        activeWorkspaceId={activeWorkspaceId}
        tasksByProject={tasksByProject}
        loadingTasksProjectIds={loadingTasksProjectIds}
        activeIssueId={activeIssueId}
        onTasksExpansionChange={onTasksExpansionChange}
        onSelectIssue={onSelectIssue}
        isLoadingProjects={isLoadingProjects}
        onSelectWorkspace={onSelectWorkspace}
        onOpenProjectPage={onOpenProjectPage}
        onOpenWorkspacesPage={onOpenWorkspacesPage}
        onOpenLastWorkspace={onOpenLastWorkspace}
        onCreateChildBoard={onCreateChildBoard}
        onSelectOrchestratorPrompt={onSelectOrchestratorPrompt}
        onRenameProject={onRenameProject}
        onChangeProjectColor={onChangeProjectColor}
        onArchiveProject={onArchiveProject}
        isMultiSelectActive={isMultiSelectActive}
        ariaLabelledBy={titleId}
      />

      {archivedProjects.length > 0 && (
        <div className="flex min-h-0 flex-col">
          <SidebarSeparator />
          <SidebarSectionHeader
            title={t('sidebar.archivedProjects', 'Archived')}
          />
          <div className="flex flex-col gap-px overflow-y-auto px-1 pb-1">
            {archivedProjects.map((project) => (
              <div
                key={project.id}
                className="group flex items-center gap-1 rounded-sm px-1 py-0.5 text-sm text-low"
                title={t('sidebar.archivedReadOnly', 'Archived — read-only')}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {onRestoreProject && (
                  <button
                    type="button"
                    onClick={() => onRestoreProject(project.id)}
                    className="invisible shrink-0 rounded-sm p-0.5 text-low hover:bg-tertiary hover:text-high group-hover:visible"
                    aria-label={t('sidebar.restoreProject', 'Restore')}
                    title={t('sidebar.restoreProject', 'Restore')}
                  >
                    <ArrowClockwiseIcon className="size-3.5" weight="bold" />
                  </button>
                )}
                {onDeleteArchivedProject && (
                  <button
                    type="button"
                    onClick={() => onDeleteArchivedProject(project.id)}
                    className="invisible shrink-0 rounded-sm p-0.5 text-low hover:bg-tertiary hover:text-error group-hover:visible"
                    aria-label={t('sidebar.deleteArchivedProject', 'Delete')}
                    title={t('sidebar.deleteArchivedProject', 'Delete')}
                  >
                    <TrashIcon className="size-3.5" weight="bold" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {bottomActions && (
        <SidebarBar
          aria-label={t('sidebar.bottomBarLabel')}
          className="mt-auto pt-2"
        >
          {bottomActions}
        </SidebarBar>
      )}
    </aside>
  );
}
