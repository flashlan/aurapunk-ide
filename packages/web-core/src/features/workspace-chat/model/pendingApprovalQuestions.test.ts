import { describe, it, expect } from 'vitest';
import type {
  ApprovalInfo,
  ApprovalQuestion,
  AskUserQuestionItem,
  NormalizedEntryType,
} from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import {
  findQuestionsInEntries,
  resolveApprovalQuestions,
  toAskUserQuestionItems,
} from './pendingApprovalQuestions';

function approval(overrides: Partial<ApprovalInfo>): ApprovalInfo {
  return {
    approval_id: 'approval-1',
    tool_name: 'AskUserQuestion',
    execution_process_id: 'proc-1',
    is_question: true,
    kind: 'question',
    created_at: '2026-09-17T00:00:00Z',
    timeout_at: '2026-09-17T01:00:00Z',
    ...overrides,
  };
}

function questionEntry(
  approvalId: string,
  questions: AskUserQuestionItem[]
): PatchTypeWithKey {
  const entry_type: NormalizedEntryType = {
    type: 'tool_use',
    tool_name: 'AskUserQuestion',
    action_type: { action: 'ask_user_question', questions },
    status: { status: 'pending_approval', approval_id: approvalId },
  };
  return {
    type: 'NORMALIZED_ENTRY',
    content: { entry_type, content: '', timestamp: null },
    patchKey: 'k:question',
    executionProcessId: 'proc-1',
  };
}

const inlineQuestions: AskUserQuestionItem[] = [
  {
    question: 'Which approach?',
    header: 'Approach',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: '' },
    ],
    multiSelect: false,
  },
];

describe('toAskUserQuestionItems', () => {
  it('fills the UI-required fields left optional on the wire type', () => {
    expect(toAskUserQuestionItems(inlineQuestions)).toEqual([
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: '' },
        ],
        multiSelect: false,
      },
    ]);
  });

  it('defaults header and option description when absent', () => {
    expect(
      toAskUserQuestionItems([
        {
          question: 'Continue?',
          options: [{ label: 'Yes' }],
          multiSelect: true,
        },
      ])
    ).toEqual([
      {
        question: 'Continue?',
        header: '',
        options: [{ label: 'Yes', description: '' }],
        multiSelect: true,
      },
    ]);
  });

  it('returns undefined for an absent or empty list', () => {
    expect(toAskUserQuestionItems(undefined)).toBeUndefined();
    expect(toAskUserQuestionItems([])).toBeUndefined();
  });

  it('tolerates a question with a missing options array', () => {
    const malformed = [
      { question: 'Pick', multiSelect: false },
    ] as unknown as ApprovalQuestion[];
    expect(toAskUserQuestionItems(malformed)).toEqual([
      {
        question: 'Pick',
        header: '',
        options: [],
        multiSelect: false,
      },
    ]);
  });
});

describe('resolveApprovalQuestions', () => {
  it('prefers the inline questions a headed approval carries', () => {
    const result = resolveApprovalQuestions(
      approval({ questions: inlineQuestions }),
      []
    );
    expect(result.isQuestion).toBe(true);
    expect(result.questions?.[0]?.question).toBe('Which approach?');
  });

  it('falls back to the transcript for a headless approval', () => {
    const result = resolveApprovalQuestions(
      approval({ questions: undefined }),
      [questionEntry('approval-1', inlineQuestions)]
    );
    expect(result.isQuestion).toBe(true);
    expect(result.questions?.[0]?.question).toBe('Which approach?');
  });

  it('ignores entries for a different approval id', () => {
    const result = resolveApprovalQuestions(
      approval({ questions: undefined }),
      [questionEntry('other-approval', inlineQuestions)]
    );
    expect(result.isQuestion).toBe(false);
    expect(result.questions).toBeUndefined();
  });

  it('does not claim a questionnaire when no questions were resolved', () => {
    const result = resolveApprovalQuestions(
      approval({ questions: undefined }),
      []
    );
    expect(result.isQuestion).toBe(false);
    expect(result.questions).toBeUndefined();
  });

  it('still renders as a question when `kind` is missing', () => {
    const result = resolveApprovalQuestions(
      approval({ kind: undefined, questions: undefined }),
      [questionEntry('approval-1', inlineQuestions)]
    );
    expect(result.isQuestion).toBe(true);
    expect(result.questions?.[0]?.question).toBe('Which approach?');
  });

  it('never treats a plan approval as a questionnaire', () => {
    const result = resolveApprovalQuestions(
      approval({ kind: 'plan_approval', questions: inlineQuestions }),
      []
    );
    expect(result.isQuestion).toBe(false);
  });
});

describe('findQuestionsInEntries', () => {
  it('returns the questions of the matching pending tool_use', () => {
    expect(
      findQuestionsInEntries(
        [questionEntry('approval-1', inlineQuestions)],
        'approval-1'
      )
    ).toEqual(inlineQuestions);
  });

  it('skips an empty placeholder entry for the same approval', () => {
    expect(
      findQuestionsInEntries(
        [
          questionEntry('approval-1', []),
          questionEntry('approval-1', inlineQuestions),
        ],
        'approval-1'
      )
    ).toEqual(inlineQuestions);
  });

  it('returns undefined when nothing matches', () => {
    expect(findQuestionsInEntries([], 'approval-1')).toBeUndefined();
  });
});
