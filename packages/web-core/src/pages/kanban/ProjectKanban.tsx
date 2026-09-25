import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { type IssuePriority, type Project } from 'shared/remote-types';
import { Group, Layout, Panel, Separator } from 'react-resizable-panels';
import { useProjects } from '@/shared/hooks/useProjects';
import { useProjectsContext } from '@/shared/providers/ProjectProvider';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useActions } from '@/shared/hooks/useActions';
import { usePageTitle } from '@/shared/hooks/usePageTitle';
import { KanbanContainer } from '@/features/kanban/ui/KanbanContainer';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { ProjectRightSidebarContainer } from './ProjectRightSidebarContainer';
import { ProjectTerminalPanelContainer } from '@/shared/components/ProjectTerminalPanelContainer';
import {
  PERSIST_KEYS,
  usePaneSize,
  useUiPreferencesStore,
} from '@/shared/stores/useUiPreferencesStore';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { useCurrentKanbanRouteState } from '@/shared/hooks/useCurrentKanbanRouteState';
import {
  buildKanbanIssueComposerKey,
  closeKanbanIssueComposer,
  type ProjectIssueCreateOptions,
} from '@/shared/stores/useKanbanIssueComposerStore';
import {
  CreateIssueDialog,
  type CreateIssueDialogPriorityOption,
  type CreateIssueDialogStatusOption,
} from '@/shared/dialogs/kanban/CreateIssueDialog';

const PRIORITY_ORDER: IssuePriority[] = ['urgent', 'high', 'medium', 'low'];
/**
 * Component that registers project mutations with ActionsContext.
 * Must be rendered inside both ActionsProvider and ProjectProvider.
 */
function ProjectMutationsRegistration({ children }: { children: ReactNode }) {
  const { registerProjectMutations } = useActions();
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const hostId = useHostId();
  const {
    projectId,
    statuses,
    issues,
    issuesById,
    getIssue,
    insertIssue,
    updateIssue,
    removeIssue,
    tags,
    issueTags,
    insertTag,
    insertIssueTag,
    removeIssueTag,
  } = useProjectContext();

  // Use ref to always access latest issues (avoid stale closure)
  const issuesRef = useRef(issues);
  useEffect(() => {
    issuesRef.current = issues;
  }, [issues]);

  const statusOptions: CreateIssueDialogStatusOption[] = useMemo(
    () =>
      [...statuses]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((status) => ({
          id: status.id,
          name: status.name,
          color: status.color,
        })),
    [statuses]
  );

  const priorityOptions: CreateIssueDialogPriorityOption[] = useMemo(
    () =>
      PRIORITY_ORDER.map((value) => ({
        value,
        label: t(`createIssueDialog.priority.${value}`),
      })),
    [t]
  );

  // Tag create callback - returns the new tag ID so it can be auto-selected.
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

  // Diff selected tags against the issue's current tags and apply the
  // junction inserts/removes so the dialog's tag state stays in sync.
  const handleTagsChange = useCallback(
    (issueId: string, tagIds: string[]) => {
      const currentIssueTags = issueTags.filter(
        (it) => it.issue_id === issueId
      );
      const currentTagIdSet = new Set(currentIssueTags.map((it) => it.tag_id));
      const newTagIdSet = new Set(tagIds);

      for (const issueTag of currentIssueTags) {
        if (!newTagIdSet.has(issueTag.tag_id)) {
          removeIssueTag(issueTag.id);
        }
      }
      for (const tagId of tagIds) {
        if (!currentTagIdSet.has(tagId)) {
          insertIssueTag({ issue_id: issueId, tag_id: tagId });
        }
      }
    },
    [issueTags, insertIssueTag, removeIssueTag]
  );

  const openCreateIssue = useCallback(
    async (options?: ProjectIssueCreateOptions): Promise<string | null> => {
      const defaultStatusId = options?.statusId ?? statusOptions[0]?.id ?? '';

      // Resolve parent issue's simple_id for the dialog hint.
      const parentIssueSimpleId = options?.parentIssueId
        ? (issuesById.get(options.parentIssueId)?.simple_id ??
          getIssue(options.parentIssueId)?.simple_id ??
          null)
        : null;

      // Close any open composer for this project so the right sidebar doesn't
      // collide with the modal. We close BEFORE awaiting creation so the
      // modal flow is unblocked by the existing sidebar.
      const composerKey = buildKanbanIssueComposerKey(hostId, projectId);
      closeKanbanIssueComposer(composerKey);

      const res = await CreateIssueDialog.show({
        projectId,
        statuses: statusOptions,
        defaultStatusId,
        priorities: priorityOptions,
        tags,
        onCreateTag: handleCreateTag,
        onTagsChange: handleTagsChange,
        parentIssueSimpleId,
        onCreate: async ({
          title,
          description,
          statusId,
          priority,
          extensionMetadata,
        }): Promise<string> => {
          // Top-of-column sort_order: min sort_order of issues in the target
          // status, minus 1 (so the new card lands at the top). Fall back to
          // 0 when the column is empty.
          const statusIssues = issuesRef.current.filter(
            (issue) => issue.status_id === statusId
          );
          const minSortOrder =
            statusIssues.length > 0
              ? Math.min(...statusIssues.map((issue) => issue.sort_order))
              : 0;

          const { persisted } = insertIssue({
            project_id: projectId,
            status_id: statusId,
            title,
            description,
            priority,
            sort_order: minSortOrder - 1,
            start_date: null,
            target_date: null,
            completed_at: null,
            parent_issue_id: options?.parentIssueId ?? null,
            parent_issue_sort_order: null,
            extension_metadata: extensionMetadata ?? {},
          });

          const syncedIssue = await persisted;

          return syncedIssue.id;
        },
        onUpdate: (issueId, changes) => {
          updateIssue(issueId, {
            title: changes.title,
            description: changes.description,
            status_id: changes.statusId,
            // The issue edit dialog is an operator surface (same override as
            // the board's completion dialog); agents cannot reach this path.
            allow_unmerged_done: true,
            priority: changes.priority,
            extension_metadata: changes.extensionMetadata,
          });
        },
      });

      if (res.action === 'created') {
        // If the dialog's embedded Workspaces composer already created and
        // navigated to a workspace, keep that destination — don't bounce
        // back to the plain issue view.
        if (res.workspaceId) {
          appNavigation.goToProjectIssueWorkspace(
            projectId,
            res.issueId,
            res.workspaceId
          );
        } else {
          appNavigation.goToProjectIssue(projectId, res.issueId);
        }
        return res.issueId;
      }
      return null;
    },
    [
      statusOptions,
      priorityOptions,
      issuesById,
      getIssue,
      insertIssue,
      updateIssue,
      tags,
      handleCreateTag,
      handleTagsChange,
      appNavigation,
      hostId,
      projectId,
      t,
    ]
  );

  // Register before the browser can process input so the native New Issue
  // menu cannot win a race against the Kanban provider mounting.
  useLayoutEffect(() => {
    registerProjectMutations({
      removeIssue: (id) => {
        removeIssue(id);
      },
      duplicateIssue: (issueId) => {
        const issue = getIssue(issueId);
        if (!issue) return;

        // Use ref to get current issues (not stale closure)
        const currentIssues = issuesRef.current;
        const statusIssues = currentIssues.filter(
          (i) => i.status_id === issue.status_id
        );
        const minSortOrder =
          statusIssues.length > 0
            ? Math.min(...statusIssues.map((i) => i.sort_order))
            : 0;

        insertIssue({
          project_id: issue.project_id,
          status_id: issue.status_id,
          title: `${issue.title} (Copy)`,
          description: issue.description,
          priority: issue.priority,
          sort_order: minSortOrder - 1,
          start_date: issue.start_date,
          target_date: issue.target_date,
          completed_at: null,
          parent_issue_id: issue.parent_issue_id,
          parent_issue_sort_order: issue.parent_issue_sort_order,
          extension_metadata: issue.extension_metadata,
        });
      },
      getIssue,
      createIssue: openCreateIssue,
    });

    return () => {
      registerProjectMutations(null);
    };
  }, [
    registerProjectMutations,
    removeIssue,
    insertIssue,
    getIssue,
    openCreateIssue,
  ]);

  return <>{children}</>;
}

function ProjectKanbanBoard() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="min-h-0 flex-1">
        <KanbanContainer />
      </div>
    </div>
  );
}

function ProjectKanbanLayout({ projectName }: { projectName: string }) {
  const { issueId, isPanelOpen } = useCurrentKanbanRouteState();
  const isMobile = useIsMobile();
  const { getIssue } = useProjectContext();
  const issue = issueId ? getIssue(issueId) : undefined;
  usePageTitle(issue?.title, projectName);
  const [kanbanLeftPanelSize, setKanbanLeftPanelSize] = usePaneSize(
    PERSIST_KEYS.kanbanLeftPanel,
    75
  );
  const isProjectTerminalOpen = useUiPreferencesStore(
    (s) => s.isProjectTerminalOpen
  );
  const toggleProjectTerminal = useUiPreferencesStore(
    (s) => s.toggleProjectTerminal
  );
  const setProjectTerminalOpen = useUiPreferencesStore(
    (s) => s.setProjectTerminalOpen
  );

  // Toggle the embedded project terminal panel with Ctrl+Shift+`.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === '`') {
        event.preventDefault();
        toggleProjectTerminal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleProjectTerminal]);

  const isRightPanelOpen = isPanelOpen;

  if (isMobile) {
    // Em mobile o Group horizontal não cabe — mostra um painel por vez.
    // Prioridade: terminal > right > board, para o terminal nunca ficar
    // atrás do workspace (“fica no fundo”). Se ambos abertos o usuário
    // fecha o terminal e volta ao workspace.
    if (isProjectTerminalOpen) {
      return (
        <div className="h-full w-full overflow-hidden bg-secondary">
          <ProjectTerminalPanelContainer
            onClose={() => setProjectTerminalOpen(false)}
          />
        </div>
      );
    }
    if (isRightPanelOpen) {
      return (
        <div className="h-full w-full overflow-hidden bg-secondary">
          <ProjectRightSidebarContainer />
        </div>
      );
    }
    return (
      <div className="h-full w-full overflow-hidden bg-primary">
        <ProjectKanbanBoard />
      </div>
    );
  }

  // Layout aninhado: terminal divide espaço com o BOARD, nunca com o
  // workspace. Estrutura: [ leftWrapper [ board | terminal ] | right ]
  // - leftWrapper = board+terminal juntos vs workspace
  // - inner split board/terminal fica dentro do leftWrapper
  const outerDefaultLayout: Layout = (() => {
    const rawLeft =
      typeof kanbanLeftPanelSize === 'number' ? kanbanLeftPanelSize : 70;
    const clampedLeft = Math.min(Math.max(rawLeft, 30), 80);
    const layout: Record<string, number> = {
      'kanban-left-wrapper': isRightPanelOpen ? clampedLeft : 100,
    };
    if (isRightPanelOpen) {
      layout['kanban-right'] = 100 - clampedLeft;
    }
    return layout;
  })();

  const innerDefaultLayout: Layout = (() => {
    const layout: Record<string, number> = {
      'kanban-board': !isProjectTerminalOpen ? 100 : isRightPanelOpen ? 68 : 75,
    };
    if (isProjectTerminalOpen) {
      layout['kanban-terminal'] = isRightPanelOpen ? 32 : 25;
    }
    return layout;
  })();

  const onOuterLayoutChange = (layout: Layout) => {
    if (layout['kanban-left-wrapper'] != null) {
      setKanbanLeftPanelSize(layout['kanban-left-wrapper']);
    }
  };

  return (
    <Group
      id="kanban-outer-group"
      orientation="horizontal"
      className="flex-1 min-w-0 h-full"
      defaultLayout={outerDefaultLayout}
      onLayoutChange={onOuterLayoutChange}
    >
      <Panel
        id="kanban-left-wrapper"
        minSize="300px"
        className="min-w-0 h-full overflow-hidden"
      >
        <Group
          id="kanban-inner-group"
          orientation="horizontal"
          className="h-full w-full"
          defaultLayout={innerDefaultLayout}
        >
          <Panel
            id="kanban-board"
            minSize="300px"
            className="min-w-0 h-full overflow-hidden bg-primary"
          >
            <ProjectKanbanBoard />
          </Panel>
          {isProjectTerminalOpen && (
            <Separator
              id="kanban-terminal-separator"
              className="w-1 bg-panel outline-none hover:bg-brand/50 transition-colors cursor-col-resize"
            />
          )}
          {isProjectTerminalOpen && (
            <Panel
              id="kanban-terminal"
              minSize="200px"
              maxSize="50%"
              className="min-w-0 h-full overflow-hidden bg-secondary"
            >
              <ProjectTerminalPanelContainer
                onClose={() => setProjectTerminalOpen(false)}
              />
            </Panel>
          )}
        </Group>
      </Panel>

      {isRightPanelOpen && (
        <Separator
          id="kanban-separator"
          className="w-1 bg-panel outline-none hover:bg-brand/50 transition-colors cursor-col-resize"
        />
      )}

      {isRightPanelOpen && (
        <Panel
          id="kanban-right"
          minSize="380px"
          className="min-w-[380px] h-full overflow-hidden bg-secondary"
        >
          <ProjectRightSidebarContainer />
        </Panel>
      )}
    </Group>
  );
}

/**
 * Inner component that renders the Kanban board once we have the project list
 * from the flat projects layer (ADR-018).
 */
function ProjectKanbanInner({ projectId }: { projectId: string }) {
  const { t } = useTranslation('common');
  const { projects, isLoading } = useProjectsContext();

  const project = projects.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('states.loading')}</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  return (
    <ProjectProvider projectId={projectId}>
      <ProjectMutationsRegistration>
        <ProjectKanbanLayout projectName={project.name} />
      </ProjectMutationsRegistration>
    </ProjectProvider>
  );
}

/**
 * ProjectKanban page - displays the Kanban board for a specific project
 *
 * URL patterns:
 * - /projects/:projectId - Kanban board with no issue selected
 * - /projects/:projectId/issues/:issueId - Kanban with issue panel open
 * - /projects/:projectId/issues/:issueId/workspaces/:workspaceId - Kanban with workspace session panel open
 * - /projects/:projectId/issues/:issueId/workspaces/create/:draftId - Kanban with workspace create panel
 *
 * Note: issue creation is composer-store state on top of /projects/:projectId.
 *
 * Note: This component is rendered inside SharedAppLayout which provides
 * NavbarContainer, AppBar, SyncErrorProvider, and ProjectProvider
 * (the flat projects layer — ADR-018).
 */
export function ProjectKanban() {
  const { projectId, hostId, hasInvalidWorkspaceCreateDraftId } =
    useCurrentKanbanRouteState();
  const appNavigation = useAppNavigation();
  const { t } = useTranslation('common');
  const issueComposerKey = useMemo(() => {
    if (!projectId) {
      return null;
    }
    return buildKanbanIssueComposerKey(hostId, projectId);
  }, [hostId, projectId]);
  const previousIssueComposerKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const previousKey = previousIssueComposerKeyRef.current;
    if (previousKey && previousKey !== issueComposerKey) {
      closeKanbanIssueComposer(previousKey);
    }

    previousIssueComposerKeyRef.current = issueComposerKey;
  }, [issueComposerKey]);

  // Redirect invalid workspace-create draft URLs back to the closed project view.
  useEffect(() => {
    if (!projectId) return;

    if (hasInvalidWorkspaceCreateDraftId) {
      appNavigation.goToProject(projectId, {
        replace: true,
      });
    }
  }, [projectId, hasInvalidWorkspaceCreateDraftId, appNavigation]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  // ProjectProvider (the flat projects layer) is already mounted by
  // SharedAppLayout — we look up the project directly via the same hook.
  const { data: projects } = useProjects();
  const project = projects.find((p: Project) => p.id === projectId);

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  return <ProjectKanbanInner projectId={projectId} />;
}
