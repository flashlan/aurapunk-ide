import { describe, it, expect } from 'vitest';
import type { NormalizedEntryType } from 'shared/types';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import {
  finalizeStaleToolStatuses,
  isLiveAgentTurn,
} from './deriveConversationEntries';

function pendingQuestionEntry(): PatchTypeWithKey {
  const entry_type: NormalizedEntryType = {
    type: 'tool_use',
    tool_name: 'question',
    action_type: {
      action: 'ask_user_question',
      questions: [
        {
          question: 'Escolha uma resposta de teste.',
          header: 'Teste DOM',
          options: [{ label: 'Opção A', description: 'primeira' }],
          multiSelect: false,
        },
      ],
    },
    status: { status: 'pending_approval', approval_id: 'approval-1' },
  };
  return {
    type: 'NORMALIZED_ENTRY',
    content: {
      entry_type,
      content: 'Escolha uma resposta de teste.',
      timestamp: null,
    },
    patchKey: 'proc-1:0',
    executionProcessId: 'proc-1',
  };
}

describe('isLiveAgentTurn', () => {
  it('treats a running turn as live', () => {
    expect(isLiveAgentTurn('agent_running')).toBe(true);
  });

  it('treats a turn parked on an approval as live', () => {
    expect(isLiveAgentTurn('agent_pending_approval')).toBe(true);
  });

  it('does not treat idle/failed turns as live', () => {
    expect(isLiveAgentTurn('agent_idle')).toBe(false);
    expect(isLiveAgentTurn('agent_failed')).toBe(false);
  });
});

describe('finalizeStaleToolStatuses', () => {
  it('keeps a pending question pending while the process is live', () => {
    const [result] = finalizeStaleToolStatuses([pendingQuestionEntry()], true);
    expect(result.type).toBe('NORMALIZED_ENTRY');
    if (result.type !== 'NORMALIZED_ENTRY') return;
    expect(result.content.entry_type.type).toBe('tool_use');
    if (result.content.entry_type.type !== 'tool_use') return;
    expect(result.content.entry_type.status.status).toBe('pending_approval');
  });

  it('finalizes a pending question as failed once the process stopped', () => {
    const [result] = finalizeStaleToolStatuses([pendingQuestionEntry()], false);
    expect(result.type).toBe('NORMALIZED_ENTRY');
    if (result.type !== 'NORMALIZED_ENTRY') return;
    expect(result.content.entry_type.type).toBe('tool_use');
    if (result.content.entry_type.type !== 'tool_use') return;
    expect(result.content.entry_type.status.status).toBe('failed');
  });
});
