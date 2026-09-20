# Aurapunk Jev Plugin: Fast Jev Compaction & the RLCD Decision Engine (Laya or Jev)

Plugin para **Claude Code** e **Aurapunk IDE (Vibe Kanban)** que substitui a sumarização com perda de contexto por decisões estruturadas **System 1** do **Jev** (TypeSafe) com fallback automático para o **Laya** (ModernBERT / Convai Innovations).

Também funciona como **Autocompact Universal** para qualquer modelo (Anthropic, OpenAI, local) e como um **Motor Autônomo de Decisão e Guardrails** de agentes.

---

## 1. Por que Fast Jev Compaction?

A compactação tradicional de contexto pede para um LLM gerar um resumo dos turnos antigos. **Resumos são inerentemente destrutivos**:
- Caminhos de arquivo exatos desaparecem.
- Erros literais do compilador somem.
- Restrições críticas dadas pelo usuário ("nunca edite `src/generated`") são omitidas ou distorcidas.

O **Fast Jev Compaction** (`tamaratran/fast-jev-compaction`):
1. **Nunca reescreve textos do usuário ou do assistente.** Textos permanecem 100% verbatim.
2. Pontua chamadas de ferramentas e seus resultados em lote via perguntas `noul` (probabilidade booleana calibrada).
3. **Poda e trunca apenas resultados de ferramentas obsoletos** ou excessivamente longos (listagens velhas, dumps de arquivos já alterados).
4. Preserva mensagens recentes e o prompt inicial intactos.

---

## 2. O que o Laya consegue fazer sozinho?

Quando a API do TypeSafe Jev não estiver configurada (`TYPESAFE_API_KEY`), offline ou em ambientes locais/air-gapped, o plugin realiza o **fallback transparente para o Laya** (`convaiinnovations/laya`).

O Laya é um motor de decisão não-autoregressivo de 421M parâmetros baseado em ModernBERT-large (`convaiinnovations/laya`), capaz de responder perguntas tipadas (`choice`, `score`, `noul`) em um único forward pass (~35 ms em GPU).

No Aurapunk IDE, o Laya decide autonomamente:

| # | Decisão | Tipo Laya | O que avalia |
|---|---|---|---|
| **1** | **Se alguma ferramenta é necessária** | `noul` | Detecta se a requisição precisa de acesso ao filesystem/shell ou pode ser resolvida sem tools. |
| **2** | **Qual ferramenta usar** | `choice` | Seleciona categoricamente a melhor ferramenta (`view_file`, `edit_file`, `run_command`, etc.). |
| **3** | **Se deve responder diretamente** | `noul` | Identifica se a intenção do usuário é conversacional / informativa. |
| **4** | **Se faltam informações** | `noul` | Detecta pedidos vagos ou ambíguos ("arrume isso") antes de gastar tokens executando. |
| **5** | **Se precisa pedir confirmação** | `noul` | Guardrail de segurança para operações de alto impacto ou irreversíveis. |
| **6** | **O nível de risco da operação** | `score` | Avalia em escala ordinal de 4 níveis: `low`, `medium`, `high`, `critical`. |
| **7** | **Se deve escalar para modelo maior** | `noul` | Roteia tarefas simples para modelos leves e escala refatorações complexas para Frontier LLMs. |
| **8** | **Se a chamada proposta combina com o pedido** | `noul` | Valida se a tool use gerada pelo agente não divergiu do que o usuário pediu. |
| **9** | **Qual agente deve receber a tarefa** | `choice` | Faz o dispatch inteligente para `planner`, `executor`, `reviewer` ou `pm`. |

---

## 3. Estrutura do Pacote

```
packages/jev-plugin/
├── .claude-plugin/
│   └── plugin.json            # Manifesto de plugin do Claude Code
├── hooks/
│   └── fast-jev.ts            # Hook session.compact para o Claude Code
├── python/
│   └── laya_bridge.py         # Ponte Python para o pacote oficial convaiinnovations/laya
├── src/
│   ├── index.ts               # Exportações públicas da biblioteca
│   ├── types.ts               # Tipagens estritas TypeScript
│   ├── compactor/
│   │   ├── engine.ts          # Algoritmo de compactação e poda verbatim
│   │   └── fitter.ts          # Ajuste de tokens e token estimator calibrado
│   ├── classifiers/
│   │   ├── interface.ts       # Interface unificada DecisionClassifier
│   │   ├── jev_classifier.ts  # Cliente da API TypeSafe Jev
│   │   ├── laya_classifier.ts # Motor Laya (HTTP, Python ou Calibrated Embedded)
│   │   └── adaptive_classifier.ts # Orquestrador Jev com fallback automático para Laya
│   ├── laya/
│   │   └── agent_decision_engine.ts # Implementação das 9 decisões autônomas
│   └── autocompact/
│       └── universal_compactor.ts # Adaptador para OpenAI, Anthropic e Aurapunk
├── poc/
│   └── demo.ts                # Demonstração executável do POC
└── tests/
    └── compactor.test.ts      # Testes unitários com Vitest
```

---

## 4. Como Executar o POC

Você pode rodar a demonstração completa interativa:

```bash
# Rodando o script de demonstração do POC
npx tsx packages/jev-plugin/poc/demo.ts
```

O POC executará:
1. **Teste das 9 decisões autônomas do Laya** em 4 cenários reais (comandos perigosos, conversação simples, prompts vagos e arquitetura pesada).
2. **Compactação Fast Jev em transcript longo** com 4 ferramentas, demonstrando a redução de tokens, corte de listagens antigas e preservação 100% literal dos textos e erros.
3. **Autocompact Universal** em formato OpenAI.

---

## 5. Instalação no Claude Code

Para usar como plugin nativo do Claude Code:

```bash
# Executar a partir deste repositório:
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir packages/jev-plugin
```

Ao rodar `/compact` ou durante o autocompact de sessões longas, o Claude Code exibirá a notificação:
```
fast-jev-compaction (LAYA): kept 9/11 messages (-48% chars, no lossy summary)
```

---

## 6. Uso em Código TypeScript / Node.js

```typescript
import { compactMessages, AgentDecisionEngine, universalAutoCompact } from '@aurapunk/jev-plugin';

// 1. Decisão autônoma com Laya
const engine = new AgentDecisionEngine();
const decision = await engine.evaluateStep({
  userRequest: 'Delete temporary tables and reset git branch',
});

if (decision.needsConfirmation.required) {
  console.log('Operação de risco:', decision.riskLevel.level);
}

// 2. Compactação de histórico
const result = await compactMessages(transcript, {
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
});

console.log(`Tokens reduzidos em ${(result.stats.reductionRatio * 100)}% sem perda de texto!`);
```

---

## 7. Rodando o Laya via Docker (OrbStack)

A imagem empacota o `docker/server.py`: um FastAPI que expõe o contrato que o
compactor chama — `POST /predict {state, questions}` → `{answers}` (alias
`/evaluate`) e `GET /health`.

```bash
# 1. Volume para o cache do Hugging Face (~2.4 GB), para não rebaixar o
#    modelo a cada recriação do container
docker volume create laya-hf-cache

# 2. Run — 8080 é o default do app (Settings → Laya execution mode: docker)
docker run -d --name aurapunk-laya --restart unless-stopped \
  -p 8080:8080 \
  -v laya-hf-cache:/root/.cache/huggingface \
  -e LAYA_MODEL=convaiinnovations/laya \
  datyapoint/vk-laya:latest

# 4. Verificar
curl -s http://localhost:8080/health   # {"status":"ok","loaded":true,...}
```

Notas:

- O servidor habilita **CORS** (`allow_origins=["*"]`): o app desktop chama de
  um webview em outra origem (`http://localhost:<porta>`), e sem os headers o
  navegador bloqueia a resposta (`Load failed`) — o container pareceria
  "inacessível" mesmo estando no ar.
- O primeiro start baixa ~2.4 GB de pesos; com o volume `laya-hf-cache` os
  starts seguintes são imediatos (o health check tem `--start-period=300s`
  por causa desse primeiro download).
- Sem GPU: a inferência roda em CPU (~1–2 s por forward; ~35 ms em GPU no host
  `sd`).
