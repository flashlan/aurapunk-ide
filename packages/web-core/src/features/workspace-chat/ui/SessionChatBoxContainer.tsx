import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  BaseAgentCapability,
  type Session,
  type BaseCodingAgent,
  ExecutionProcessStatus,
  PermissionPolicy,
  type ExecutorConfig,
} from 'shared/types';
import { AgentIcon } from '@/shared/components/AgentIcon';
import { useHostId } from '@/shared/providers/HostIdProvider';
import { workspaceSessionKeys } from '@/shared/hooks/workspaceSessionKeys';
import { useWorkspaceExecution } from '@/shared/hooks/useWorkspaceExecution';
import { useWorkspaceRepo } from '@/shared/hooks/useWorkspaceRepo';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import WYSIWYGEditor, {
  type WYSIWYGEditorRef,
} from '@/shared/components/WYSIWYGEditor';
import { useApprovalFeedbackOptional } from '../model/contexts/ApprovalFeedbackContext';
import { useMessageEditContext } from '../model/contexts/MessageEditContext';
import { useEntries, useTokenUsage } from '../model/contexts/EntriesContext';
import { useExecutionProcesses } from '@/shared/hooks/useExecutionProcesses';
import { useReviewOptional } from '@/shared/hooks/useReview';
import { useActions } from '@/shared/hooks/useActions';
import { useTodos } from '../model/hooks/useTodos';
import { getLatestConfigFromProcesses } from '@/shared/lib/executor';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { useWorkspaceChatConfig } from '@/shared/hooks/useWorkspaceChatConfig';
import { useSessionMessageEditor } from '../model/hooks/useSessionMessageEditor';
import { useSessionQueueInteraction } from '../model/hooks/useSessionQueueInteraction';
import { useSessionSend } from '../model/hooks/useSessionSend';
import { useSessionAttachments } from '../model/hooks/useSessionAttachments';
import { useMessageEditRetry } from '../model/hooks/useMessageEditRetry';
import { useBranchStatus } from '@/shared/hooks/useBranchStatus';
import { useWorkspaceBranch } from '../model/hooks/useWorkspaceBranch';
import { useApprovalMutation } from '../model/hooks/useApprovalMutation';
import { pickPendingApproval } from '../model/pendingApprovalQuestions';
import { useApprovals } from '@/shared/hooks/useApprovals';
import { ResolveConflictsDialog } from '@/shared/dialogs/tasks/ResolveConflictsDialog';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { buildAgentPrompt } from '@/shared/lib/promptMessage';
import { formatDateShortWithTime } from '@/shared/lib/date';
import { toPrettyCase } from '@/shared/lib/string';
import {
  SessionChatBox,
  type ExecutionStatus,
  type SessionChatBoxEditorRenderProps,
} from '@vibe/ui/components/SessionChatBox';
import { ModelSelectorContainer } from '@/shared/components/ModelSelectorContainer';
import {
  useWorkspacePanelState,
  RIGHT_MAIN_PANEL_MODES,
  useAnimateRunningOutline,
  useCompactorEngine,
  useLayaDockerUrl,
  useJevApiKey,
} from '@/shared/stores/useUiPreferencesStore';
import { useAutoCompaction } from '../model/hooks/useAutoCompaction';
import {
  executeSessionCompaction,
  prepareCloudPromptWithIsolation,
} from '../model/sessionCompactor';
import { useInspectModeStore } from '../model/store/useInspectModeStore';
import { Actions } from '@/shared/actions';
import {
  isSpecialIcon,
  getActionTooltip,
  isActionEnabled,
  isActionVisible,
  type ActionDefinition,
} from '@/shared/types/actions';
import { SettingsDialog } from '@/shared/dialogs/settings/SettingsDialog';
import { useActionVisibilityContext } from '@/shared/hooks/useActionVisibilityContext';
import { PrCommentsDialog } from '@/shared/dialogs/tasks/PrCommentsDialog';
import type { NormalizedComment } from '@vibe/ui/components/pr-comment-node';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { sessionsApi } from '@/shared/lib/api';
import { getInteractiveConfig } from '@/shared/lib/interactive';
import { RenameSessionDialog } from '@vibe/ui/components/RenameSessionDialog';
import type { TurnNavigationItem } from '@vibe/ui/components/TurnNavigationPopup';

const MEMORY_SLASH_COMMAND = {
  name: 'memory',
  description: 'Open memory adapters and endpoint settings',
} as const;

/** Compute execution status from boolean flags */
function computeExecutionStatus(params: {
  isInFeedbackMode: boolean;
  isInEditMode: boolean;
  isStopping: boolean;
  isQueueLoading: boolean;
  isSendingFollowUp: boolean;
  isQueued: boolean;
  isAttemptRunning: boolean;
}): ExecutionStatus {
  if (params.isInFeedbackMode) return 'feedback';
  if (params.isInEditMode) return 'edit';
  if (params.isStopping) return 'stopping';
  if (params.isQueueLoading) return 'queue-loading';
  if (params.isSendingFollowUp) return 'sending';
  // isQueued alone isn't enough: the process the message was queued behind
  // can finish (isAttemptRunning flips false) before the backend actually
  // flushes the queue into a new execution (crates/local-deployment/src/
  // container.rs's post-completion handler, which runs off the process-exit
  // event, not synchronously with it). In that gap the server still reports
  // the message as queued, but there is nothing running for Stop to act on
  // — plain 'queued' would render an interactive-looking Stop button that's
  // actually a no-op (Cancel Queue still works either way). Use
  // 'queued-idle' for that gap: Cancel Queue only, no dead Stop button. It
  // flips to plain 'queued' once the flushed follow-up's process appears.
  if (params.isQueued)
    return params.isAttemptRunning ? 'queued' : 'queued-idle';
  if (params.isAttemptRunning) return 'running';
  return 'idle';
}

/** Shared props across all modes */
interface SharedProps {
  /** Available sessions for this workspace */
  sessions: Session[];
  /** Number of files changed in current session */
  filesChanged: number;
  /** Number of lines added */
  linesAdded: number;
  /** Number of lines removed */
  linesRemoved: number;
  /** Callback to scroll to previous user message */
  onScrollToPreviousMessage: () => void;
  /** Callback to scroll to bottom of conversation */
  onScrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  /** Callback to scroll to a specific user message by patchKey */
  onScrollToUserMessage: (patchKey: string) => void;
  /** Returns the patchKey of the user message currently visible in the viewport */
  getActiveTurnPatchKey?: () => string | null;
  /** Disable the "view code" click handler (for VS Code extension) */
  disableViewCode: boolean;
  /** Replace diff stats with an "Open Workspace" button in header */
  showOpenWorkspaceButton: boolean;
}

/** Props for existing session mode */
interface ExistingSessionProps extends SharedProps {
  mode: 'existing-session';
  /** The current session */
  session: Session;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
  /** Callback to start new session mode */
  onStartNewSession: (() => void) | undefined;
}

/** Props for new session mode */
interface NewSessionProps extends SharedProps {
  mode: 'new-session';
  /** Workspace ID for creating new sessions */
  workspaceId: string;
  /** Called when a session is selected */
  onSelectSession: (sessionId: string) => void;
}

/** Props for placeholder mode (no workspace selected) */
interface PlaceholderProps extends SharedProps {
  mode: 'placeholder';
}

type SessionChatBoxContainerProps =
  | ExistingSessionProps
  | NewSessionProps
  | PlaceholderProps;

export function SessionChatBoxContainer(props: SessionChatBoxContainerProps) {
  const {
    mode,
    sessions,
    filesChanged,
    linesAdded,
    linesRemoved,
    onScrollToPreviousMessage,
    onScrollToBottom,
    onScrollToUserMessage,
    getActiveTurnPatchKey,
    disableViewCode = false,
    showOpenWorkspaceButton,
  } = props;

  // Extract mode-specific values
  const session = mode === 'existing-session' ? props.session : undefined;
  const workspaceId =
    mode === 'existing-session'
      ? props.session.workspace_id
      : mode === 'new-session'
        ? props.workspaceId
        : undefined;
  const isNewSessionMode = mode === 'new-session';
  const onSelectSession =
    mode === 'placeholder' ? undefined : props.onSelectSession;
  const onStartNewSession =
    mode === 'existing-session' ? props.onStartNewSession : undefined;

  const sessionId = session?.id;
  const queryClient = useQueryClient();
  const hostId = useHostId();
  const [animateRunningOutline] = useAnimateRunningOutline();

  const handleRenameSession = useCallback(
    (targetSessionId: string, currentName: string) => {
      void RenameSessionDialog.show({
        currentName,
        onRename: async (newName: string) => {
          await sessionsApi.update(targetSessionId, { name: newName });
          void queryClient.invalidateQueries({
            queryKey: workspaceSessionKeys.byWorkspace(workspaceId, hostId),
          });
        },
      });
    },
    [queryClient, hostId, workspaceId]
  );
  const appNavigation = useAppNavigation();

  const { executeAction } = useActions();
  const actionCtx = useActionVisibilityContext();
  const { rightMainPanelMode, setRightMainPanelMode } =
    useWorkspacePanelState(workspaceId);

  const handleViewCode = useCallback(() => {
    setRightMainPanelMode(
      rightMainPanelMode === RIGHT_MAIN_PANEL_MODES.CHANGES
        ? null
        : RIGHT_MAIN_PANEL_MODES.CHANGES
    );
  }, [rightMainPanelMode, setRightMainPanelMode]);

  const handleOpenWorkspace = useCallback(() => {
    if (!workspaceId) return;
    appNavigation.goToWorkspace(workspaceId);
  }, [appNavigation, workspaceId]);

  // Get entries early to extract pending approval for scratch key
  const { entries, setEntries } = useEntries();
  const tokenUsageInfo = useTokenUsage();

  // Extract user messages for turn navigation
  const userMessageTurns: TurnNavigationItem[] = useMemo(() => {
    let turnNumber = 0;
    return entries
      .filter(
        (entry) =>
          entry.type === 'NORMALIZED_ENTRY' &&
          entry.content.entry_type.type === 'user_message'
      )
      .map((entry) => {
        turnNumber++;
        return {
          patchKey: entry.patchKey,
          content:
            entry.type === 'NORMALIZED_ENTRY' ? entry.content.content : '',
          turnNumber,
        };
      });
  }, [entries]);

  // Execution state
  const { isAttemptRunning, stopExecution, isStopping, processes } =
    useWorkspaceExecution(workspaceId);

  // Approvals state
  const { pendingApprovals } = useApprovals();

  // Get pending approval from running processes. Prefer a questionnaire over a
  // concurrent tool permission so the question's options are not shadowed.
  const pendingApproval = useMemo(
    () =>
      pickPendingApproval(
        pendingApprovals,
        processes
          .filter((p) => p.status === ExecutionProcessStatus.running)
          .map((p) => p.id),
        entries
      ),
    [processes, pendingApprovals, entries]
  );

  // Use approval_id as scratch key when pending approval exists to avoid
  // prefilling approval response with queued follow-up message
  const scratchId = useMemo(() => {
    if (pendingApproval?.approvalId) {
      return pendingApproval.approvalId;
    }
    return isNewSessionMode ? workspaceId : sessionId;
  }, [pendingApproval?.approvalId, isNewSessionMode, workspaceId, sessionId]);

  // Get repos for file search
  const { repos } = useWorkspaceRepo(workspaceId);
  const repoIds = repos.map((r) => r.id);

  // Approval feedback context
  const feedbackContext = useApprovalFeedbackOptional();
  const isInFeedbackMode = !!feedbackContext?.activeApproval;

  // Message edit context
  const editContext = useMessageEditContext();
  const isInEditMode = editContext.isInEditMode;

  // Get todos from entries
  const { todos, inProgressTodo } = useTodos(entries);

  // Review comments context (optional - only available when ReviewProvider wraps this)
  const reviewContext = useReviewOptional();
  const reviewMarkdown = useMemo(
    () => reviewContext?.generateReviewMarkdown() ?? '',
    [reviewContext]
  );
  const hasReviewComments = (reviewContext?.comments.length ?? 0) > 0;

  // Approval mutation for approve/deny/answer actions
  const {
    approveAsync,
    denyAsync,
    answerAsync,
    isApproving,
    isDenying,
    isAnswering,
    denyError,
    answerError,
  } = useApprovalMutation();

  // Branch status for edit retry and conflict detection
  const { data: branchStatus } = useBranchStatus(workspaceId);

  // Derive conflict state from branch status
  const hasConflicts = useMemo(() => {
    return (
      branchStatus?.some((r) => (r.conflicted_files?.length ?? 0) > 0) ?? false
    );
  }, [branchStatus]);

  const conflictedFilesCount = useMemo(() => {
    return (
      branchStatus?.reduce(
        (sum, r) => sum + (r.conflicted_files?.length ?? 0),
        0
      ) ?? 0
    );
  }, [branchStatus]);

  // Get workspace branch for conflict resolution dialog
  const { branch: attemptBranch } = useWorkspaceBranch(workspaceId);

  // Find the first repo with conflicts (for the resolve dialog)
  const repoWithConflicts = useMemo(
    () =>
      branchStatus?.find(
        (r) => r.is_rebase_in_progress || (r.conflicted_files?.length ?? 0) > 0
      ),
    [branchStatus]
  );

  const handleResolveConflicts = useCallback(() => {
    if (!workspaceId || !repoWithConflicts) return;
    ResolveConflictsDialog.show({
      workspaceId,
      conflictOp: repoWithConflicts.conflict_op ?? 'rebase',
      sourceBranch: attemptBranch,
      targetBranch: repoWithConflicts.target_branch_name,
      conflictedFiles: repoWithConflicts.conflicted_files ?? [],
      repoName: repoWithConflicts.repo_name,
    });
  }, [workspaceId, repoWithConflicts, attemptBranch]);

  // User profiles, config preference, and latest executor from processes
  const { profiles, config, capabilities } = useUserSystem();

  // Fetch processes from last session to get full profile (only in new session mode)
  const lastSessionId = isNewSessionMode ? sessions?.[0]?.id : undefined;
  const { executionProcesses: lastSessionProcesses } =
    useExecutionProcesses(lastSessionId);

  // Compute latestConfig: current processes > last session processes > session metadata
  const latestConfig = useMemo(() => {
    // Current session's processes take priority (full ExecutorConfig)
    const fromProcesses = getLatestConfigFromProcesses(processes);
    if (fromProcesses) return fromProcesses;

    // Try full config from last session's processes
    const fromLastSession = getLatestConfigFromProcesses(lastSessionProcesses);
    if (fromLastSession) return fromLastSession;

    // Fallback: just executor from session metadata
    const lastSessionExecutor = sessions?.[0]?.executor;
    if (lastSessionExecutor) {
      return {
        executor: lastSessionExecutor as BaseCodingAgent,
      };
    }

    return null;
  }, [processes, lastSessionProcesses, sessions]);

  const needsExecutorSelection =
    isNewSessionMode || (!session?.executor && !latestConfig?.executor);

  // Message editor state
  const {
    localMessage,
    setLocalMessage,
    scratchData,
    saveToScratch,
    clearDraft,
    cancelDebouncedSave,
    handleMessageChange,
  } = useSessionMessageEditor({ scratchId });

  // Ref to access current message value for attachment handler
  const localMessageRef = useRef(localMessage);
  useEffect(() => {
    localMessageRef.current = localMessage;
  }, [localMessage]);

  // Ref to imperatively focus the message editor (drops the cursor into the
  // chat when a workspace is opened, e.g. by clicking it on an issue card).
  const editorRef = useRef<WYSIWYGEditorRef>(null);

  // Focus the chat input whenever the active workspace/session opens (card
  // click, sidebar selection, new-session), so the user can type immediately
  // instead of having to click the box first.
  useEffect(() => {
    if (!workspaceId) return;
    const raf = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [workspaceId, sessionId, isNewSessionMode]);

  // Attachment handling - insert markdown when attachments are uploaded
  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      const currentMessage = localMessageRef.current;
      const newMessage = currentMessage.trim()
        ? `${currentMessage}\n\n${markdown}`
        : markdown;
      setLocalMessage(newMessage);
    },
    [setLocalMessage]
  );

  // Auto-paste component context from inspect mode
  const pendingComponentMarkdown = useInspectModeStore(
    (s) => s.pendingComponentMarkdown
  );
  const clearPendingComponentMarkdown = useInspectModeStore(
    (s) => s.clearPendingComponentMarkdown
  );

  useEffect(() => {
    if (pendingComponentMarkdown) {
      handleInsertMarkdown(pendingComponentMarkdown);
      clearPendingComponentMarkdown();
    }
  }, [
    pendingComponentMarkdown,
    handleInsertMarkdown,
    clearPendingComponentMarkdown,
  ]);

  const { uploadFiles, localAttachments, clearUploadedAttachments } =
    useSessionAttachments(workspaceId, sessionId, handleInsertMarkdown);

  // Defaults do workspace (salvos pelo app/Mobile): valem quando o usuário
  // não escolheu nada. O CLI só entra se não forçar troca em sessão rodada
  // (o servidor rejeitaria com ExecutorMismatch).
  const { data: savedChatConfig } = useWorkspaceChatConfig(workspaceId);
  const workspaceDefaults = useMemo<Partial<ExecutorConfig> | null>(() => {
    if (!savedChatConfig) return null;
    const sessionExecutor = session?.executor ?? null;
    const hasExecutions = (processes?.length ?? 0) > 0;
    const out: Partial<ExecutorConfig> = {};
    const savedExecutor = savedChatConfig.executor as
      | BaseCodingAgent
      | undefined;
    if (
      savedExecutor &&
      (!profiles || savedExecutor in profiles) &&
      (!hasExecutions || !sessionExecutor || sessionExecutor === savedExecutor)
    ) {
      out.executor = savedExecutor;
    }
    if (savedChatConfig.preset) out.variant = savedChatConfig.preset;
    if (savedChatConfig.model_id) out.model_id = savedChatConfig.model_id;
    if (savedChatConfig.agent_id) out.agent_id = savedChatConfig.agent_id;
    if (savedChatConfig.reasoning_id)
      out.reasoning_id = savedChatConfig.reasoning_id;
    if (
      savedChatConfig.permission_policy &&
      savedChatConfig.permission_policy in PermissionPolicy
    ) {
      out.permission_policy =
        savedChatConfig.permission_policy as PermissionPolicy;
    }
    return out;
  }, [savedChatConfig, session?.executor, processes, profiles]);

  // Unified executor + variant + model selector options resolution
  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    presetOptions,
    setExecutor: handleExecutorChange,
    setVariant: setSelectedVariant,
    setOverrides: setExecutorOverrides,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: latestConfig,
    scratchConfig: scratchData?.executor_config ?? undefined,
    workspaceDefaults,
    configExecutorProfile: config?.executor_profile,
    onPersist: (cfg) => void saveToScratch(localMessageRef.current, cfg),
  });

  const supportsContextUsage =
    !!effectiveExecutor &&
    capabilities?.[effectiveExecutor]?.includes(
      BaseAgentCapability.CONTEXT_USAGE
    );

  // Navigate to agent settings to customise variants
  const handleCustomise = () => {
    SettingsDialog.show({ initialSection: 'agents' });
  };

  // Queue interaction
  const {
    isQueued,
    queuedMessage,
    queuedConfig,
    isQueueLoading,
    queueMessage,
    cancelQueue,
    refreshQueueStatus,
  } = useSessionQueueInteraction({ sessionId });

  // Send actions
  const {
    send,
    isSending,
    error: sendError,
    clearError,
  } = useSessionSend({
    sessionId,
    workspaceId,
    isNewSessionMode,
    onSelectSession,
    executorConfig,
  });

  const compactorEngine = useCompactorEngine();
  const layaDockerUrl = useLayaDockerUrl();
  const jevApiKey = useJevApiKey();

  // Auto-compaction when context usage crosses the user threshold
  useAutoCompaction({
    sessionId: isNewSessionMode ? undefined : sessionId,
    tokenUsageInfo,
    executorConfig,
    isRunning:
      isAttemptRunning ||
      isSending ||
      isStopping ||
      !!pendingApproval?.approvalId,
    entries,
    setEntries,
  });

  const handleSend = useCallback(async () => {
    const trimmed = localMessage.trim();
    if (/^\/memory\s*$/i.test(trimmed)) {
      cancelDebouncedSave();
      setLocalMessage('');
      clearUploadedAttachments();
      await clearDraft();
      void SettingsDialog.show({ initialSection: 'memory' });
      return;
    }

    // Direct /compress, /autocompress, /compact, /autocompact command:
    if (
      /^\/(?:compress|autocompress|compact|autocompact)(?:\s.*)?$/i.test(trimmed)
    ) {
      cancelDebouncedSave();
      setLocalMessage('');
      clearUploadedAttachments();
      await clearDraft();
      onScrollToBottom('auto');

      try {
        const { markerPatch } = await executeSessionCompaction({
          entries,
          engine: compactorEngine,
          layaDockerUrl,
          jevApiKey,
        });
        setEntries([...entries, markerPatch]);
      } catch (err) {
        console.warn('[compaction] Failed to execute manual compaction:', err);
      }
      return;
    }

    const { prompt: rawPrompt, isSlashCommand } = buildAgentPrompt(localMessage, [
      reviewMarkdown,
    ]);

    // Isolate context: everything above the latest compaction marker is dropped!
    const prompt = isSlashCommand
      ? rawPrompt
      : prepareCloudPromptWithIsolation(rawPrompt, entries);

    onScrollToBottom('auto');

    const success = await send(prompt);
    if (success) {
      cancelDebouncedSave();
      setLocalMessage('');
      clearUploadedAttachments();
      // The editor draft is persisted per session so a refresh can recover
      // unsent text. Once the send succeeded, remove it for existing and new
      // sessions alike; otherwise a refresh restores an already-sent prompt.
      await clearDraft();
      if (!isSlashCommand) {
        reviewContext?.clearComments();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onScrollToBottom('auto');
        });
      });
    }
  }, [
    onScrollToBottom,
    send,
    localMessage,
    reviewMarkdown,
    cancelDebouncedSave,
    setLocalMessage,
    clearUploadedAttachments,
    clearDraft,
    reviewContext,
    entries,
    setEntries,
    compactorEngine,
    layaDockerUrl,
    jevApiKey,
  ]);

  // --- Headed (interactive tmux) live status ---------------------------------
  // A headed session stays `running` across turns (the tmux/agent process
  // never exits between turns), so the headless "queue, flush when the
  // process stops" mechanism never flushes for it. Send is NOT specially
  // routed here anymore, though: it always goes through the normal
  // follow-up flow (`handleSend` -> POST /follow-up), which already detects
  // a live headed tmux session server-side and injects the prompt directly
  // into it via `send_interactive_message` (bracketed-paste + Enter) whether
  // the agent is idle or mid-turn, falling back to a fresh `--resume`
  // execution if the tmux session died in the meantime — see
  // `should_deliver_to_live_session` in
  // crates/server/src/routes/sessions/mod.rs and
  // docs/ADR/ADR-031-headed-send-always-live-delivery.md. This block only
  // tracks whether there's a live headed process and whether it looks busy,
  // to pick the 'headed-busy' status (working-pulse animation) below —
  // `executionProcessesApi.sendInput`/`send_interactive_input` (single-line,
  // no newlines) remains reserved for short operator keystrokes elsewhere
  // (e.g. approvals), not for composing full messages.

  // Latest running coding-agent process that is headed (`processes` is sorted
  // created_at ascending, so take the last match).
  const headedLiveProcess = useMemo(
    () =>
      processes.findLast(
        (p) =>
          p.run_reason === 'codingagent' &&
          p.status === 'running' &&
          getInteractiveConfig(p) != null
      ) ?? null,
    [processes]
  );

  // Busy = the spinner's loading patch is present for this process (the same
  // signal that drives the timeline spinner).
  const headedLoadingPresent = useMemo(
    () =>
      !!headedLiveProcess &&
      entries.some(
        (e) =>
          e.type === 'NORMALIZED_ENTRY' &&
          e.content.entry_type.type === 'loading' &&
          e.executionProcessId === headedLiveProcess.id
      ),
    [entries, headedLiveProcess]
  );

  // Track previous process count for queue refresh
  const prevProcessCountRef = useRef(processes.length);

  // Refresh queue status when execution stops or new process starts
  useEffect(() => {
    const prevCount = prevProcessCountRef.current;
    prevProcessCountRef.current = processes.length;

    if (!workspaceId) return;

    if (!isAttemptRunning) {
      refreshQueueStatus();
      return;
    }

    if (processes.length > prevCount) {
      refreshQueueStatus();
    }
  }, [isAttemptRunning, workspaceId, processes.length, refreshQueueStatus]);

  // Queue message handler
  const handleQueueMessage = useCallback(async () => {
    // Allow queueing if there's a message OR review comments, and we have a config
    if ((!localMessage.trim() && !reviewMarkdown) || !executorConfig) return;

    const { prompt } = buildAgentPrompt(localMessage, [reviewMarkdown]);

    cancelDebouncedSave();
    await saveToScratch(localMessage, executorConfig);
    await queueMessage(prompt, executorConfig);

    // Clear local state after queueing (same as handleSend)
    setLocalMessage('');
    clearUploadedAttachments();
    reviewContext?.clearComments();
  }, [
    localMessage,
    reviewMarkdown,
    executorConfig,
    queueMessage,
    cancelDebouncedSave,
    saveToScratch,
    setLocalMessage,
    clearUploadedAttachments,
    reviewContext,
  ]);

  // Editor change handler
  const handleEditorChange = useCallback(
    (value: string) => {
      if (isQueued) cancelQueue();
      if (executorConfig) {
        handleMessageChange(value, executorConfig);
      } else {
        setLocalMessage(value);
      }
      if (sendError) clearError();
    },
    [
      isQueued,
      cancelQueue,
      handleMessageChange,
      executorConfig,
      sendError,
      clearError,
      setLocalMessage,
    ]
  );

  // Handle feedback submission
  const handleSubmitFeedback = useCallback(async () => {
    if (!feedbackContext || !localMessage.trim()) return;
    try {
      await feedbackContext.submitFeedback(localMessage);
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();
    } catch {
      // Error is handled in context
    }
  }, [
    feedbackContext,
    localMessage,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
  ]);

  // Handle cancel feedback mode
  const handleCancelFeedback = useCallback(() => {
    feedbackContext?.exitFeedbackMode();
  }, [feedbackContext]);

  // Handle cancel queue - restore message to editor
  const handleCancelQueue = useCallback(async () => {
    if (queuedMessage) {
      setLocalMessage(queuedMessage);
    }
    if (queuedConfig) {
      setExecutorOverrides(queuedConfig);
    }
    await cancelQueue();
  }, [
    queuedMessage,
    queuedConfig,
    setLocalMessage,
    setExecutorOverrides,
    cancelQueue,
  ]);

  // Message edit retry mutation
  const editRetryMutation = useMessageEditRetry(sessionId ?? '', () => {
    // On success, clear edit mode and reset editor
    editContext.cancelEdit();
    cancelDebouncedSave();
    setLocalMessage('');
  });

  const areAttachmentInputsDisabled =
    mode === 'placeholder' ||
    isQueued ||
    isSending ||
    isStopping ||
    !!feedbackContext?.isSubmitting ||
    editRetryMutation.isPending ||
    isApproving ||
    isDenying ||
    isAnswering;

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        uploadFiles(acceptedFiles);
      }
    },
    [uploadFiles]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: areAttachmentInputsDisabled,
    noClick: true,
    noKeyboard: true,
  });

  // Handle edit submission
  const handleSubmitEdit = useCallback(async () => {
    if (!editContext.activeEdit || !localMessage.trim() || !executorConfig)
      return;
    editRetryMutation.mutate({
      message: localMessage,
      executorConfig,
      executionProcessId: editContext.activeEdit.processId,
      branchStatus,
      processes,
    });
  }, [
    editContext.activeEdit,
    localMessage,
    executorConfig,
    branchStatus,
    processes,
    editRetryMutation,
  ]);

  // Handle cancel edit mode
  const handleCancelEdit = useCallback(() => {
    editContext.cancelEdit();
    setLocalMessage('');
  }, [editContext, setLocalMessage]);

  // Populate editor with original message when entering edit mode
  const prevEditRef = useRef(editContext.activeEdit);
  useEffect(() => {
    if (editContext.activeEdit && !prevEditRef.current) {
      // Just entered edit mode - populate with original message
      setLocalMessage(editContext.activeEdit.originalMessage);
    }
    prevEditRef.current = editContext.activeEdit;
  }, [editContext.activeEdit, setLocalMessage]);

  // Handle inserting PR comments into the message editor
  const handleInsertPrComments = useCallback(async () => {
    if (!workspaceId) return;
    const repoId = repos[0]?.id;
    if (!repoId) return;

    const result = await PrCommentsDialog.show({
      workspaceId: workspaceId,
      repoId,
    });
    if (result.comments.length > 0) {
      const markdownBlocks = result.comments.map((comment) => {
        const payload: NormalizedComment = {
          id:
            comment.comment_type === 'general'
              ? comment.id
              : comment.id.toString(),
          comment_type: comment.comment_type,
          author: comment.author,
          body: comment.body,
          created_at: comment.created_at,
          url: comment.url,
          ...(comment.comment_type === 'review' && {
            path: comment.path,
            line: comment.line != null ? Number(comment.line) : null,
            diff_hunk: comment.diff_hunk,
          }),
        };
        return '```gh-comment\n' + JSON.stringify(payload, null, 2) + '\n```';
      });
      handleInsertMarkdown(markdownBlocks.join('\n\n'));
    }
  }, [workspaceId, repos, handleInsertMarkdown]);

  // Toolbar actions handler
  const handleToolbarAction = useCallback(
    (action: ActionDefinition) => {
      if (action.requiresTarget && workspaceId) {
        executeAction(action, workspaceId);
      } else {
        executeAction(action);
      }
    },
    [executeAction, workspaceId]
  );

  // Define which actions appear in the toolbar
  const toolbarActionsList = useMemo(
    () =>
      [Actions.StartReview].filter((action) =>
        isActionVisible(action, actionCtx)
      ),
    [actionCtx]
  );

  const toolbarActionItems = useMemo(
    () =>
      toolbarActionsList.flatMap((action) => {
        if (isSpecialIcon(action.icon)) {
          return [];
        }

        const label = action.label;

        return [
          {
            id: action.id,
            icon: action.icon,
            label,
            tooltip: getActionTooltip(action, actionCtx),
            disabled: !isActionEnabled(action, actionCtx),
            onClick: () => handleToolbarAction(action),
          },
        ];
      }),
    [toolbarActionsList, actionCtx, handleToolbarAction]
  );

  // Handle approve action
  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;

    // Exit feedback mode if active
    feedbackContext?.exitFeedbackMode();

    try {
      await approveAsync({
        approvalId: pendingApproval.approvalId,
        executionProcessId: pendingApproval.executionProcessId,
      });

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    feedbackContext,
    approveAsync,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle request changes (deny with feedback)
  const handleRequestChanges = useCallback(async () => {
    if (!pendingApproval || !localMessage.trim()) return;

    try {
      await denyAsync({
        approvalId: pendingApproval.approvalId,
        executionProcessId: pendingApproval.executionProcessId,
        reason: localMessage.trim(),
      });
      cancelDebouncedSave();
      setLocalMessage('');
      await clearDraft();

      // Invalidate workspace summary cache to update sidebar
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      onScrollToBottom();
    } catch {
      // Error is handled by mutation
    }
  }, [
    pendingApproval,
    localMessage,
    denyAsync,
    cancelDebouncedSave,
    setLocalMessage,
    clearDraft,
    queryClient,
    onScrollToBottom,
  ]);

  // Handle AskUserQuestion answer submission
  const handleAnswerQuestion = useCallback(
    async (answers: Array<{ question: string; answer: string[] }>) => {
      if (!pendingApproval) return;

      try {
        await answerAsync({
          approvalId: pendingApproval.approvalId,
          executionProcessId: pendingApproval.executionProcessId,
          answers,
        });
        queryClient.invalidateQueries({
          queryKey: workspaceSummaryKeys.all,
        });
        onScrollToBottom();
      } catch {
        // Error is handled by mutation
      }
    },
    [pendingApproval, answerAsync, queryClient, onScrollToBottom]
  );

  // Check if approval is timed out
  const isApprovalTimedOut = pendingApproval
    ? new Date() > new Date(pendingApproval.timeoutAt)
    : false;

  const status = computeExecutionStatus({
    isInFeedbackMode,
    isInEditMode,
    isStopping,
    isQueueLoading,
    isSendingFollowUp: isSending,
    isQueued,
    isAttemptRunning,
  });

  // A live headed session overrides `status` entirely: `isAttemptRunning`
  // stays true continuously for it (the tmux/agent process never exits
  // between turns), so the base `status` would otherwise be stuck on
  // 'running' (Queue+Stop, no Send) even between turns. 'headed-busy' vs.
  // 'idle' only drives the working-pulse animation now (see
  // SessionChatBox.tsx — both render the same enabled Send). Send itself is
  // never gated on this: it's always the normal `handleSend`.
  const effectiveStatus: ExecutionStatus = headedLiveProcess
    ? headedLoadingPresent
      ? 'headed-busy'
      : 'idle'
    : status;

  // In approval mode, don't show queued message - it's for follow-up, not approval response
  const editorValue = useMemo(() => {
    if (pendingApproval) return localMessage;
    return queuedMessage ?? localMessage;
  }, [pendingApproval, queuedMessage, localMessage]);

  const renderEditor = useCallback(
    ({
      focusKey,
      placeholder,
      value,
      onChange,
      onCmdEnter,
      disabled,
      repoIds,
      executor,
      onPasteFiles,
      localAttachments,
    }: SessionChatBoxEditorRenderProps<BaseCodingAgent>) => (
      <WYSIWYGEditor
        key={focusKey}
        ref={editorRef}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onCmdEnter={onCmdEnter}
        disabled={disabled}
        className="min-h-double max-h-[50vh] overflow-y-auto"
        repoIds={repoIds}
        executor={executor}
        additionalSlashCommands={[MEMORY_SLASH_COMMAND]}
        sessionId={sessionId}
        autoFocus
        onPasteFiles={onPasteFiles}
        localAttachments={localAttachments}
        sendShortcut={config?.send_message_shortcut}
      />
    ),
    [config?.send_message_shortcut, sessionId]
  );

  const modelSelectorNode = effectiveExecutor ? (
    <ModelSelectorContainer
      slot="model"
      agent={effectiveExecutor}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onAdvancedSettings={handleCustomise}
      presets={variantOptions}
      selectedPreset={selectedVariant}
      onPresetSelect={setSelectedVariant}
      onOverrideChange={setExecutorOverrides}
      executorConfig={executorConfig}
      presetOptions={presetOptions}
    />
  ) : undefined;

  const agentSelectorNode = effectiveExecutor ? (
    <ModelSelectorContainer
      slot="agent"
      agent={effectiveExecutor}
      workspaceId={workspaceId}
      sessionId={sessionId}
      onAdvancedSettings={handleCustomise}
      presets={variantOptions}
      selectedPreset={selectedVariant}
      onPresetSelect={setSelectedVariant}
      onOverrideChange={setExecutorOverrides}
      executorConfig={executorConfig}
      presetOptions={presetOptions}
    />
  ) : undefined;

  // In placeholder mode, render a disabled version to maintain visual structure
  if (mode === 'placeholder') {
    return (
      <SessionChatBox<BaseCodingAgent>
        status="idle"
        renderEditor={renderEditor}
        repoIds={repoIds}
        tokenUsageInfo={tokenUsageInfo}
        supportsContextUsage={false}
        formatExecutorLabel={toPrettyCase}
        formatSessionDate={(createdAt) =>
          formatDateShortWithTime(
            createdAt instanceof Date ? createdAt.toISOString() : createdAt
          )
        }
        renderAgentIcon={(executor, className) => (
          <AgentIcon
            agent={executor as BaseCodingAgent | null | undefined}
            className={className}
          />
        )}
        editor={{
          value: '',
          onChange: () => {},
        }}
        actions={{
          onSend: () => {},
          onQueue: () => {},
          onCancelQueue: () => {},
          onStop: () => {},
          onClearEditor: () => {},
          onPasteFiles: () => {},
        }}
        session={{
          sessions: [],
          selectedSessionId: undefined,
          onSelectSession: () => {},
          isNewSessionMode: false,
          onNewSession: undefined,
        }}
        stats={{
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
        }}
        onViewCode={disableViewCode ? undefined : handleViewCode}
      />
    );
  }

  return (
    <SessionChatBox<BaseCodingAgent>
      status={effectiveStatus}
      animateRunningOutline={animateRunningOutline}
      disableContentInsert={!!headedLiveProcess}
      onViewCode={disableViewCode ? undefined : handleViewCode}
      onOpenWorkspace={
        showOpenWorkspaceButton && workspaceId ? handleOpenWorkspace : undefined
      }
      onScrollToPreviousMessage={onScrollToPreviousMessage}
      userMessageTurns={userMessageTurns}
      onScrollToUserMessage={onScrollToUserMessage}
      getActiveTurnPatchKey={getActiveTurnPatchKey}
      renderEditor={renderEditor}
      repoIds={repoIds}
      tokenUsageInfo={tokenUsageInfo}
      supportsContextUsage={supportsContextUsage}
      formatExecutorLabel={toPrettyCase}
      formatSessionDate={(createdAt) =>
        formatDateShortWithTime(
          createdAt instanceof Date ? createdAt.toISOString() : createdAt
        )
      }
      renderAgentIcon={(executor, className) => (
        <AgentIcon
          agent={executor as BaseCodingAgent | null | undefined}
          className={className}
        />
      )}
      editor={{
        value: editorValue,
        onChange: handleEditorChange,
      }}
      actions={{
        // Always the normal follow-up send, headed or not — see the
        // headed-live status block above for why. Files are not uploadable
        // into a live tmux session, so onPasteFiles is a no-op there.
        onSend: handleSend,
        onQueue: handleQueueMessage,
        onCancelQueue: handleCancelQueue,
        onStop: stopExecution,
        onClearEditor: () => {
          setLocalMessage('');
          clearDraft();
        },
        onPasteFiles: headedLiveProcess ? () => {} : uploadFiles,
      }}
      session={{
        sessions,
        selectedSessionId: sessionId,
        onSelectSession: onSelectSession ?? (() => {}),
        isNewSessionMode: needsExecutorSelection,
        onNewSession: onStartNewSession,
        onRenameSession: handleRenameSession,
      }}
      toolbarActions={{
        items: toolbarActionItems,
      }}
      onPrCommentClick={
        headedLiveProcess
          ? undefined
          : actionCtx.hasOpenPR
            ? handleInsertPrComments
            : undefined
      }
      stats={{
        filesChanged,
        linesAdded,
        linesRemoved,
        hasConflicts,
        conflictedFilesCount,
        onResolveConflicts: handleResolveConflicts,
      }}
      error={sendError}
      agent={effectiveExecutor}
      todos={todos}
      inProgressTodo={inProgressTodo}
      executor={
        needsExecutorSelection
          ? {
              selected: effectiveExecutor,
              options: executorOptions,
              onChange: handleExecutorChange,
            }
          : undefined
      }
      feedbackMode={
        feedbackContext
          ? {
              isActive: isInFeedbackMode,
              onSubmitFeedback: handleSubmitFeedback,
              onCancel: handleCancelFeedback,
              isSubmitting: feedbackContext.isSubmitting,
              error: feedbackContext.error,
              isTimedOut: feedbackContext.isTimedOut,
            }
          : undefined
      }
      approvalMode={
        pendingApproval && !pendingApproval.isQuestion
          ? {
              isActive: true,
              onApprove: handleApprove,
              onRequestChanges: handleRequestChanges,
              isSubmitting: isApproving || isDenying,
              isTimedOut: isApprovalTimedOut,
              error: denyError?.message ?? null,
            }
          : undefined
      }
      askQuestionMode={
        pendingApproval?.isQuestion
          ? {
              isActive: true,
              questions: pendingApproval.questions ?? [],
              onSubmitAnswers: handleAnswerQuestion,
              isSubmitting: isAnswering,
              isTimedOut: isApprovalTimedOut,
              error: answerError?.message ?? null,
            }
          : undefined
      }
      editMode={{
        isActive: isInEditMode,
        onSubmitEdit: handleSubmitEdit,
        onCancel: handleCancelEdit,
        isSubmitting: editRetryMutation.isPending,
      }}
      reviewComments={
        // Not supported in headed-live mode (would feed hasContent / banner and
        // could be re-sent or left staged); gated off there.
        headedLiveProcess
          ? undefined
          : hasReviewComments && reviewContext
            ? {
                count: reviewContext.comments.length,
                previewMarkdown: reviewMarkdown,
                onClear: reviewContext.clearComments,
              }
            : undefined
      }
      localAttachments={localAttachments}
      dropzone={{ getRootProps, getInputProps, isDragActive }}
      modelSelector={modelSelectorNode}
      agentSelector={agentSelectorNode}
    />
  );
}
