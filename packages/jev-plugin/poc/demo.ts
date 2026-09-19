/**
 * Proof of Concept (POC) Demonstration
 * Fast Jev Compaction + Laya System-1 Decision Engine
 *
 * Demonstrates:
 * 1. O que o Laya consegue fazer sozinho (as 9 decisões autônomas)
 * 2. Fast Jev Compaction em transcripts realistas com poda e truncamento
 * 3. Fallback transparente de Jev para Laya
 * 4. Universal Autocompact para múltiplos formatos de modelos
 */

import {
  AgentDecisionEngine,
  compactMessages,
  universalAutoCompact,
  AdaptiveClassifier,
  type Message,
} from '../src/index.js';

async function runPoc() {
  console.log('='.repeat(78));
  console.log('  AURAPUNK IDE — JEV PLUGIN + LAYA SYSTEM-1 DECISION ENGINE POC');
  console.log('='.repeat(78));

  // =========================================================================
  // PARTE 1: O QUE O LAYA CONSEGUE FAZER SOZINHO (9 DECISÕES AUTÔNOMAS)
  // =========================================================================
  console.log('\n======================================================================');
  console.log('  PARTE 1: O que o Laya consegue fazer sozinho (9 Decisões de Agente)');
  console.log('======================================================================\n');

  const engine = new AgentDecisionEngine();

  const scenarios = [
    {
      name: 'Cenário A: Operação Destrutiva no Terminal',
      input: {
        userRequest: 'Limpe o diretório de build e dê reset forçado no git: rm -rf dist/ && git reset --hard HEAD~1',
        proposedCall: {
          tool: 'run_command',
          input: { command: 'rm -rf dist/ && git reset --hard HEAD~1' },
        },
      },
    },
    {
      name: 'Cenário B: Conversação / Pergunta Direta',
      input: {
        userRequest: 'Olá! O que é autocompact e por que ele é essencial em vibe coding de nível 3?',
      },
    },
    {
      name: 'Cenário C: Pedido Incompleto / Vago',
      input: {
        userRequest: 'faça aquilo',
      },
    },
    {
      name: 'Cenário D: Refatoração Arquitetural de Grande Porte',
      input: {
        userRequest:
          'Refactor whole architecture to distributed event-sourcing with zero-downtime database migration across 4 microservices',
      },
    },
  ];

  for (const s of scenarios) {
    console.log(`>>> ${s.name}`);
    console.log(`    Request: "${s.input.userRequest}"`);

    const dec = await engine.evaluateStep(s.input);

    console.log('    [Decisões do Laya]:');
    console.log(`      1. Ferramenta necessária?        : ${dec.needsTool.needed ? 'SIM' : 'NÃO'} (P = ${dec.needsTool.confidence})`);
    console.log(`      2. Qual ferramenta usar?         : ${dec.toolChoice.tool} (confiança: ${dec.toolChoice.confidence})`);
    console.log(`      3. Responder diretamente?        : ${dec.respondDirectly.direct ? 'SIM' : 'NÃO'} (P = ${dec.respondDirectly.confidence})`);
    console.log(`      4. Faltam informações?           : ${dec.missingInformation.hasMissingInfo ? 'SIM' : 'NÃO'} (P = ${dec.missingInformation.confidence})`);
    console.log(`      5. Precisa pedir confirmação?    : ${dec.needsConfirmation.required ? 'SIM (!)' : 'NÃO'} (P = ${dec.needsConfirmation.confidence})`);
    console.log(`      6. Nível de risco da operação    : [${dec.riskLevel.level.toUpperCase()}] (score: ${dec.riskLevel.score})`);
    console.log(`      7. Escalar para modelo maior?    : ${dec.escalateToLargerModel.escalate ? 'SIM (Frontier LLM)' : 'NÃO (System-1)'} (P = ${dec.escalateToLargerModel.confidence})`);
    console.log(`      8. Chamada proposta combina?     : ${dec.callMatchesRequest.matches ? 'SIM' : 'NÃO'} (P = ${dec.callMatchesRequest.confidence})`);
    console.log(`      9. Qual agente deve receber?     : [${dec.agentRouting.agent}] (confiança: ${dec.agentRouting.confidence})`);
    console.log(`    [Latência]: ${dec.latencyMs} ms | [Engine]: ${dec.provider}\n`);
  }

  // =========================================================================
  // PARTE 2: FAST JEV COMPACTION COM FALLBACK PARA LAYA
  // =========================================================================
  console.log('======================================================================');
  console.log('  PARTE 2: Fast Jev Compaction em Transcripts (com Laya Fallback)');
  console.log('======================================================================\n');

  // Gerando um transcript realista longo com saída de ferramentas pesada
  const sampleTranscript: Message[] = [
    {
      role: 'user',
      text: 'Spec: Corrija o bug no compactor e nunca remova o prompt inicial do usuário.',
    },
    {
      role: 'assistant',
      text: 'Vou listar os arquivos do diretório para inspecionar o código.',
      toolUses: [
        {
          tool_use_id: 'call_1_ls',
          tool: 'list_dir',
          input: { DirectoryPath: '/workspace/project' },
        },
      ],
    },
    {
      role: 'user',
      toolResults: [
        {
          tool_use_id: 'call_1_ls',
          text: 'file1.ts\nfile2.ts\nfile3.ts\nfile4.ts\n'.repeat(60), // Lista longa antiga
        },
      ],
    },
    {
      role: 'assistant',
      text: 'Agora vou ler o arquivo principal de configuração.',
      toolUses: [
        {
          tool_use_id: 'call_2_view',
          tool: 'view_file',
          input: { AbsolutePath: '/workspace/project/large_config.json' },
        },
      ],
    },
    {
      role: 'user',
      toolResults: [
        {
          tool_use_id: 'call_2_view',
          text: '// Large config JSON dump\n' + JSON.stringify({ items: Array.from({ length: 150 }, (_, i) => ({ id: i, name: `item_${i}` })) }, null, 2),
        },
      ],
    },
    {
      role: 'assistant',
      text: 'Encontrei um erro ao rodar o teste anterior. Deixe-me ver o log de erro.',
      toolUses: [
        {
          tool_use_id: 'call_3_test_err',
          tool: 'run_command',
          input: { CommandLine: 'pnpm test' },
        },
      ],
    },
    {
      role: 'user',
      toolResults: [
        {
          tool_use_id: 'call_3_test_err',
          text: 'FAIL: src/compactor.test.ts:42\nError: Assertion failed at line 42: expected reduction > 20%',
          is_error: true,
        },
      ],
    },
    {
      role: 'assistant',
      text: 'Entendido. O erro está na linha 42. Vou aplicar o patch no arquivo.',
      toolUses: [
        {
          tool_use_id: 'call_4_edit',
          tool: 'replace_file_content',
          input: { TargetFile: 'src/compactor.ts', ReplacementContent: 'return ratio >= 0.2;' },
        },
      ],
    },
    {
      role: 'user',
      toolResults: [
        {
          tool_use_id: 'call_4_edit',
          text: 'Replaced lines 40-45 successfully.',
        },
      ],
    },
    {
      role: 'assistant',
      text: 'Pronto! Apliquei a alteração e agora o teste deve passar. Verificando...',
    },
  ];

  console.log('Executando compactMessages()...');
  const compaction = await compactMessages(sampleTranscript, {
    preserveRecentMessages: 4,
    keepThreshold: 0.5,
    truncateHeadChars: 150,
  });

  console.log('\n--- Relatório de Compactação ---');
  console.log(`Provedor utilizado           : ${compaction.stats.providerUsed.toUpperCase()}`);
  console.log(`Mensagens (antes -> depois)  : ${compaction.stats.messagesBefore} -> ${compaction.stats.messagesAfter}`);
  console.log(`Caracteres (antes -> depois) : ${compaction.stats.charsBefore} -> ${compaction.stats.charsAfter}`);
  console.log(`Tokens estimados             : ~${compaction.stats.estimatedTokensBefore} -> ~${compaction.stats.estimatedTokensAfter}`);
  console.log(`Taxa de Redução de Contexto  : ${(compaction.stats.reductionRatio * 100).toFixed(1)}%`);
  console.log(`Chamadas mantidas completas  : ${compaction.stats.toolCallsKeptFull}`);
  console.log(`Chamadas truncadas           : ${compaction.stats.toolCallsTruncated}`);
  console.log(`Chamadas/Resultados podados  : ${compaction.stats.toolCallsDropped}`);
  console.log(`Tempo de execução            : ${compaction.stats.durationMs} ms`);

  console.log('\nDecisões detalhadas por ferramenta:');
  for (const d of compaction.decisions) {
    console.log(`  - [${d.tool}] (id: ${d.tool_use_id}) => Ação: ${d.action.toUpperCase()} (keepCall=${d.keepCall}, keepResult=${d.keepResult})`);
  }

  // Verificação de integridade verbatim
  console.log('\nVerificação de Integridade Verbatim:');
  const initialPromptKept = compaction.messages[0].text === sampleTranscript[0].text;
  const recentMessageKept = compaction.messages[compaction.messages.length - 1].text === sampleTranscript[sampleTranscript.length - 1].text;
  console.log(`  ✓ Prompt inicial preservado 100% idêntico: ${initialPromptKept ? 'SIM' : 'NÃO'}`);
  console.log(`  ✓ Mensagem mais recente preservada intacta: ${recentMessageKept ? 'SIM' : 'NÃO'}`);

  // =========================================================================
  // PARTE 3: UNIVERSAL AUTOCOMPACT PARA QUALQUER MODELO (FORMATO OPENAI)
  // =========================================================================
  console.log('\n======================================================================');
  console.log('  PARTE 3: Universal Autocompact (Formato OpenAI / Qualquer Modelo)');
  console.log('======================================================================\n');

  const openAiHistory = [
    { role: 'system', content: 'Você é um assistente prestativo.' },
    { role: 'user', content: 'Inspecione a pasta do projeto.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_openai_1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_openai_1',
      content: 'long_file_list.txt\n'.repeat(100),
    },
    { role: 'assistant', content: 'Aqui estão os arquivos.' },
    { role: 'user', content: 'Qual o próximo passo?' },
  ];

  const autoResult = await universalAutoCompact(openAiHistory, {
    format: 'openai',
    tokenThreshold: 50, // Força compactação para o POC
    preserveRecentMessages: 2,
    truncateHeadChars: 80,
  });

  console.log(`Autocompact executado com sucesso: ${autoResult.compacted ? 'SIM' : 'NÃO'}`);
  console.log(`Tokens antes -> depois : ~${autoResult.tokensBefore} -> ~${autoResult.tokensAfter}`);
  console.log(`Tamanho do transcript pós-compactação: ${autoResult.transcript.length} mensagens`);

  console.log('\n' + '='.repeat(78));
  console.log('  POC CONCLUÍDO COM SUCESSO! Fast-Jev + Laya operando universalmente.');
  console.log('='.repeat(78) + '\n');
}

runPoc().catch((err) => {
  console.error('POC Error:', err);
  process.exit(1);
});
