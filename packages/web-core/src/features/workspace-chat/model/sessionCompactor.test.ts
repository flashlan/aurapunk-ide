import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/shared/hooks/useConversationHistory/types';
import {
  findLatestCompactionMarkerIndex,
  sliceEntriesFromLastMarker,
  prepareCloudPromptWithIsolation,
  executeSessionCompaction,
} from './sessionCompactor';

function makeUserPatch(text: string, id: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `user-${id}`,
    executionProcessId: id,
    content: {
      timestamp: null,
      entry_type: { type: 'user_message' },
      content: text,
    },
  };
}

function makeAssistantPatch(text: string, id: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `assistant-${id}`,
    executionProcessId: id,
    content: {
      timestamp: null,
      entry_type: { type: 'assistant_message' },
      content: text,
    },
  };
}

function makeToolPatch(tool: string, output: string, id: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `tool-${id}`,
    executionProcessId: id,
    content: {
      timestamp: null,
      entry_type: {
        type: 'tool_use',
        tool_name: tool,
        action_type: { action: 'command_run', command: tool, result: { output, exit_status: 0 }, category: 'other' },
        status: { status: 'completed' },
      },
      content: output,
    },
  };
}

function makeCompactionMarkerPatch(summary: string, id: string): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `marker-${id}`,
    executionProcessId: id,
    content: {
      timestamp: new Date().toISOString(),
      entry_type: {
        type: 'compaction_marker',
        previous_tokens: 120000,
        compacted_tokens: 8500,
        mem0_synced: true,
      },
      content: summary,
    },
  };
}

describe('sessionCompactor - Context Slicing & Marker Isolation', () => {
  it('returns all entries when no compaction marker exists', () => {
    const entries: PatchTypeWithKey[] = [
      makeUserPatch('Primeiro prompt', '1'),
      makeAssistantPatch('Resposta 1', '1'),
      makeUserPatch('Segundo prompt', '2'),
    ];

    const result = sliceEntriesFromLastMarker(entries);
    expect(result.hasCompactedBoundary).toBe(false);
    expect(result.marker).toBeNull();
    expect(result.activeEntries).toHaveLength(3);
    expect(result.isolatedEntriesCount).toBe(0);
  });

  it('strictly isolates everything ABOVE the marker and keeps only from the marker down', () => {
    const entries: PatchTypeWithKey[] = [
      makeUserPatch('Prompt velho que não deve ir pro modelo', '1'),
      makeToolPatch('run_command', '500 linhas de logs velhos de erro...', '1'),
      makeAssistantPatch('Corrigi o erro', '1'),
      makeCompactionMarkerPatch('### Marco: Erro corrigido com sucesso', 'marker-1'),
      makeUserPatch('Novo prompt após a marca', '2'),
      makeAssistantPatch('Resposta fresca', '2'),
    ];

    const markerIdx = findLatestCompactionMarkerIndex(entries);
    expect(markerIdx).toBe(3);

    const result = sliceEntriesFromLastMarker(entries);
    expect(result.hasCompactedBoundary).toBe(true);
    expect(result.marker?.content).toBe('### Marco: Erro corrigido com sucesso');
    expect(result.isolatedEntriesCount).toBe(3);
    expect(result.activeEntries).toHaveLength(2);
    expect(result.activeEntries[0].content.content).toBe('Novo prompt após a marca');
    expect(result.activeEntries[1].content.content).toBe('Resposta fresca');
  });

  it('prepares cloud prompt injecting the isolated milestone and omitting stale history', () => {
    const entries: PatchTypeWithKey[] = [
      makeUserPatch('Lixo antigo', '1'),
      makeToolPatch('view_file', '800 linhas de código velho...', '1'),
      makeCompactionMarkerPatch('Resumo Consolidado dos Marcos Anteriores', 'm1'),
      makeUserPatch('Pergunta recente', '2'),
    ];

    const cloudPrompt = prepareCloudPromptWithIsolation('Novo pedido do usuário', entries);
    expect(cloudPrompt).toContain('[Contexto Consolidado da Sessão Anterior (Marco de Compactação)]');
    expect(cloudPrompt).toContain('Resumo Consolidado dos Marcos Anteriores');
    expect(cloudPrompt).toContain('Novo pedido do usuário');
    expect(cloudPrompt).not.toContain('800 linhas de código velho');
    expect(cloudPrompt).not.toContain('Lixo antigo');
  });

  it('executes session compaction using Laya and creates a valid compaction marker patch', async () => {
    const entries: PatchTypeWithKey[] = [
      makeUserPatch('Implemente o componente do chat', '1'),
      makeToolPatch('run_command', 'cargo test passed 42 tests', '1'),
      makeAssistantPatch('Componente criado com sucesso', '1'),
    ];

    const result = await executeSessionCompaction({
      entries,
      engine: 'laya',
    });

    expect(result.markerPatch.type).toBe('NORMALIZED_ENTRY');
    expect(result.markerPatch.content.entry_type.type).toBe('compaction_marker');
    expect(result.summary).toContain('✂ Contexto Compactado & Marco de Sessão');
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
  });
});
