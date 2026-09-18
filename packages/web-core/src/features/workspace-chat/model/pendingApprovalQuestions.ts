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
    options: q.options.map((o) => ({
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
      return entryType.action_type.questions;
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
 * `isQuestion` is true only when there is at least one question to render, so
 * the chat box falls back to the approve/deny bar instead of showing a dead
 * question banner.
 */
export function resolveApprovalQuestions(
  info: ApprovalInfo,
  entries: PatchTypeWithKey[]
): { isQuestion: boolean; questions: AskUserQuestionItem[] | undefined } {
  const questions =
    toAskUserQuestionItems(info.questions) ??
    findQuestionsInEntries(entries, info.approval_id);
  return {
    isQuestion: info.kind === 'question' && (questions?.length ?? 0) > 0,
    questions,
  };
}
