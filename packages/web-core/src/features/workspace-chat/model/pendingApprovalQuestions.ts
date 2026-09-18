import type {
  ApprovalInfo,
  ApprovalQuestion,
  AskUserQuestionItem,
} from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';

/**
 * Map an approval's inline question payload to the chat box's question shape,
 * filling the fields the UI declares as required but the approval wire type
 * leaves optional (`header`, option `description`).
 */
export function toAskUserQuestionItems(
  questions: ApprovalQuestion[] | undefined
): AskUserQuestionItem[] | undefined {
  if (!questions?.length) return undefined;
  return questions.map((q) => ({
    question: q.question,
    header: q.header ?? '',
    options: (q.options ?? []).map((o) => ({
      label: o.label,
      description: o.description ?? '',
    })),
    multiSelect: q.multiSelect,
  }));
}

/**
 * Headless approvals don't carry the question content inline (only the kind),
 * so recover it from the pending `AskUserQuestion` tool_use entry whose status
 * carries the matching backend approval id.
 */
export function findQuestionsInEntries(
  entries: PatchTypeWithKey[],
  approvalId: string
): AskUserQuestionItem[] | undefined {
  for (const entry of entries) {
    if (entry.type !== 'NORMALIZED_ENTRY') continue;
    const entryType = entry.content.entry_type;
    if (
      entryType.type === 'tool_use' &&
      entryType.status.status === 'pending_approval' &&
      entryType.status.approval_id === approvalId &&
      entryType.action_type.action === 'ask_user_question'
    ) {
      // A placeholder entry for the same call can exist before the question
      // payload arrives; it must not shadow a later entry that actually
      // carries options.
      if (entryType.action_type.questions.length > 0) {
        return entryType.action_type.questions;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the questions for a pending approval.
 *
 * Headed (interactive tmux) approvals carry them inline on the approval stream
 * (`ApprovalInfo.questions`, populated by the PreToolUse bridge): the agent
 * transcript never sees the backend approval_id — that id is only emitted on
 * the headless client-log path — so scanning entries alone would leave a headed
 * AskUserQuestion with no options. Prefer the inline copy and fall back to the
 * transcript scan for headless approvals, which set only the kind.
 *
 * `isQuestion` is driven by the *resolved* questions, not by `kind` alone: a
 * question approval whose `kind` is missing (older backends) or whose inline
 * copy is empty still renders as long as options were recovered. A plan
 * approval is never treated as a questionnaire. When no questions resolve, the
 * chat box falls back to the approve/deny bar instead of a dead banner.
 */
export function resolveApprovalQuestions(
  info: ApprovalInfo,
  entries: PatchTypeWithKey[]
): { isQuestion: boolean; questions: AskUserQuestionItem[] | undefined } {
  const questions =
    toAskUserQuestionItems(info.questions) ??
    findQuestionsInEntries(entries, info.approval_id);
  const hasQuestions = (questions?.length ?? 0) > 0;
  return {
    isQuestion: hasQuestions && info.kind !== 'plan_approval',
    questions,
  };
}

/** What the chat box needs to render a pending approval's action bar. */
export interface PendingApprovalSummary {
  approvalId: string;
  timeoutAt: string;
  executionProcessId: string;
  isQuestion: boolean;
  questions: AskUserQuestionItem[] | undefined;
}

/**
 * Pick which pending approval the chat box acts on.
 *
 * A single execution process can have more than one approval in flight — e.g.
 * OpenCode raises a tool/directory permission while a questionnaire is also
 * waiting. Returning whichever comes first would let the permission "shadow"
 * the question, so the chat box renders the approve/deny bar and the operator
 * never sees the options. Prefer a resolvable question; fall back to the first
 * pending approval otherwise (the permission surfaces once the question is
 * answered).
 */
export function pickPendingApproval(
  approvals: ApprovalInfo[],
  runningProcessIds: Iterable<string>,
  entries: PatchTypeWithKey[]
): PendingApprovalSummary | null {
  const running = new Set(runningProcessIds);
  const resolved = approvals
    .filter((info) => running.has(info.execution_process_id))
    .map((info) => ({ info, ...resolveApprovalQuestions(info, entries) }));
  const chosen =
    resolved.find((candidate) => candidate.isQuestion) ?? resolved[0];
  if (!chosen) return null;
  return {
    approvalId: chosen.info.approval_id,
    timeoutAt: chosen.info.timeout_at,
    executionProcessId: chosen.info.execution_process_id,
    isQuestion: chosen.isQuestion,
    questions: chosen.questions,
  };
}
