import { describe, expect, it } from 'vitest';
import {
  AgentDecisionEngine,
  compactMessages,
  universalAutoCompact,
  isolateAndCompactContext,
  calculateReductionRatio,
  LayaClassifier,
  type Message,
} from '../src/index.js';

describe('Fast Jev Compactor with Laya Fallback', () => {
  it('compacts stale tool calls while preserving recent messages and initial prompt verbatim', async () => {
    const transcript: Message[] = [
      { role: 'user', text: 'Prompt inicial: Corrija o teste.' },
      {
        role: 'assistant',
        toolUses: [{ tool_use_id: 'call_1', tool: 'view_file', input: { file: 'a.ts' } }],
      },
      {
        role: 'user',
        toolResults: [{ tool_use_id: 'call_1', text: 'large content line\n'.repeat(100) }],
      },
      { role: 'assistant', text: 'Analisando o arquivo.' },
      { role: 'user', text: 'Mensagem recente 1' },
      { role: 'assistant', text: 'Mensagem recente 2' },
    ];

    const result = await compactMessages(transcript, {
      preserveRecentMessages: 2,
      truncateHeadChars: 50,
      keepThreshold: 0.5,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    // Initial prompt preserved verbatim
    expect(result.messages[0].text).toBe('Prompt inicial: Corrija o teste.');
    // Reduction achieved
    expect(result.stats.reductionRatio).toBeGreaterThan(0.2);
    // Recent message preserved verbatim
    expect(result.messages[result.messages.length - 1].text).toBe('Mensagem recente 2');
  });

  it('calculates reduction ratios accurately', () => {
    expect(calculateReductionRatio(1000, 500)).toBe(0.5);
    expect(calculateReductionRatio(1000, 1000)).toBe(0);
    expect(calculateReductionRatio(0, 0)).toBe(0);
  });
});

describe('Laya Standalone 9 Decisions', () => {
  const engine = new AgentDecisionEngine();

  it('evaluates destructive operations as high risk and needing confirmation', async () => {
    const assessment = await engine.evaluateStep({
      userRequest: 'Exclua o banco e resete o git: rm -rf data/ && git reset --hard',
      proposedCall: {
        tool: 'run_command',
        input: { command: 'rm -rf data/' },
      },
    });

    expect(assessment.needsTool.needed).toBe(true);
    expect(assessment.needsConfirmation.required).toBe(true);
    expect(['high', 'critical']).toContain(assessment.riskLevel.level);
    expect(assessment.toolChoice.tool).toBe('run_command');
  });

  it('evaluates conversational greeting as direct response with no tools needed', async () => {
    const assessment = await engine.evaluateStep({
      userRequest: 'Olá! Quem é você?',
    });

    expect(assessment.needsTool.needed).toBe(false);
    expect(assessment.respondDirectly.direct).toBe(true);
    expect(assessment.riskLevel.level).toBe('low');
    expect(assessment.needsConfirmation.required).toBe(false);
  });

  it('flags vague requests as missing information', async () => {
    const assessment = await engine.evaluateStep({
      userRequest: 'faça aquilo',
    });

    expect(assessment.missingInformation.hasMissingInfo).toBe(true);
  });

  it('detects complex architectural requests for escalation', async () => {
    const assessment = await engine.evaluateStep({
      userRequest:
        'Refactor whole architecture to distributed event-sourcing with zero-downtime migration',
    });

    expect(assessment.escalateToLargerModel.escalate).toBe(true);
    expect(['planner', 'architect']).toContain(assessment.agentRouting.agent);
  });
});

describe('Universal Autocompactor for any model', () => {
  it('compacts OpenAI formatted history and returns valid OpenAI format', async () => {
    const openAiHistory = [
      { role: 'system', content: 'Você é um assistente.' },
      { role: 'user', content: 'Execute o comando.' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_oa_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_oa_1',
        content: 'line of output\n'.repeat(50),
      },
      { role: 'assistant', content: 'Finalizado.' },
      { role: 'user', content: 'Obrigado.' },
    ];

    const output = await universalAutoCompact(openAiHistory, {
      format: 'openai',
      preserveRecentMessages: 2,
      truncateHeadChars: 40,
    });

    expect(output.compacted).toBe(true);
    expect(output.tokensAfter).toBeLessThan(output.tokensBefore);
    expect(Array.isArray(output.transcript)).toBe(true);
  });
});

describe('Context Isolation & Prompt Cache Protection', () => {
  it('isolates noisy historical tool outputs while preserving cache anchor and active window verbatim', () => {
    const chatHistory: Message[] = [
      { role: 'system', text: 'Você é um assistente de desenvolvimento sênior do Aurapunk IDE.' },
      { role: 'user', text: 'Liste os arquivos e rode o build.' },
      {
        role: 'assistant',
        text: 'Vou listar os arquivos.',
        toolUses: [{ tool_use_id: 'call_1', tool: 'list_dir', input: { path: '.' } }],
        toolResults: [{ tool_use_id: 'call_1', text: 'file1.txt\nfile2.txt\n'.repeat(100) }],
      },
      {
        role: 'assistant',
        text: 'Agora vou rodar o build.',
        toolUses: [{ tool_use_id: 'call_2', tool: 'run_command', input: { cmd: 'cargo check' } }],
        toolResults: [{ tool_use_id: 'call_2', text: 'Compiling crate v0.1...\n'.repeat(200) }],
      },
      { role: 'user', text: 'Agora crie a função de soma.' },
      { role: 'assistant', text: 'Criando a função soma agora.' },
    ];

    const result = isolateAndCompactContext(chatHistory, {
      activeWindowSize: 2,
      preserveCacheAnchor: true,
      maxHistoricalResultChars: 80,
    });

    // 1. Initial Cache Anchor is 100% identical (guarantees Prompt Caching hit)
    expect(result.payloadForModel[0].text).toBe('Você é um assistente de desenvolvimento sênior do Aurapunk IDE.');

    // 2. Active Window (last 2 messages) is 100% untouched
    expect(result.payloadForModel[result.payloadForModel.length - 2].text).toBe('Agora crie a função de soma.');
    expect(result.payloadForModel[result.payloadForModel.length - 1].text).toBe('Criando a função soma agora.');

    // 3. Historical tool outputs are pruned and summarized, cutting volatile tokens
    expect(result.metrics.prunedToolResultsCount).toBe(2);
    expect(result.metrics.savedVolatileTokens).toBeGreaterThan(0);
    expect(result.payloadForModel[2].toolResults?.[0].text).toContain('[fast-jev context-isolation');
  });
});
