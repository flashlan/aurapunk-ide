# Guia de Orquestração Swarm Multi-Agente, MCP e RAG no Vibe Kanban

Este documento serve como o manual definitivo para a operação do sistema de **Swarm Multi-Agente**, **Servidor MCP** e gerenciamento de **RAG / Contexto** no `vibe-kanban-alternative`.

---

## 🏛️ 1. Arquitetura da Esteira Multi-Agente (Pipeline Swarm)

Em vez de sobrecarregar um único modelo com todo o ciclo de vida do desenvolvimento, a esteira divide o trabalho em **etapas especializadas** com contexto limpo e transição via worktree Git compartilhada:

```
[ 1. Plan (Gemini 2.5 Pro) ] 
            │
            ▼ (Gera SPEC.md + IMPLEMENTATION_PLAN.md)
[ 2. Code (Claude 3.7 Sonnet) ]
            │
            ▼ (Implementa código e testes unitários)
[ 3. Audit (Codex Review) ]
            │
            ▼ (Audita diff, segurança e linter)
[ 4. Live Preview Gate (Dev Server na porta 3003) ] ── (Opcional: Espera aprovação do Dev)
            │
            ▼ (Após aprovação do Dev)
[ 5. Squash-Merge to Base & DONE ]
```

---

## 🧠 2. Os 4 Locais para Edição de RAG e Contexto

O conhecimento e contexto dos agentes são organizados em 4 camadas complementares:

### 1. Memória Persistente Vetorial (`mem0`)
* **Onde editar**: ⚙️ **Settings ➔ Memory** (ou API local `http://localhost:8000`).
* **O que configura**:
  * Provedor de Embeddings/RAG (Groq, OpenRouter, Llama local, OpenAI).
  * Graph Memory (grafo de conexões entre entidades, regras e arquivos).
* **Como os agentes alimentam o RAG**:
  * De forma totalmente agentic, via tools MCP: `memory_search` (busca semântica por uma query específica do card, chamada ANTES de começar) e `memory_save` (grava um fato verificado e autocontido, chamado DEPOIS do trabalho verificado). Não há mais injeção automática de um bloco com todas as memórias no início do prompt — isso desperdiçava contexto e invalidava o prefixo do prompt-cache a cada nova memória salva.

### 2. Contexto Mestre do Projeto (Orchestrator Prompt / `AGENTS.md`)
* **Onde editar na UI**: No topo do Quadro Kanban, clique no botão **`Orchestrator Prompt`**.
* **Onde editar no Repositório**: Arquivo [`AGENTS.md`](https://github.com/flashlan/vibe-kanban-alternative/blob/main/AGENTS.md) (ou `CLAUDE.md`) na raiz do repositório.
* **O que colocar**: Diretrizes globais obrigatórias (estilo de código, comandos de build e testes como `cargo test`, `pnpm run check`, regras de branches).

### 3. Contexto da Tarefa (`SPEC.md` e `IMPLEMENTATION_PLAN.md`)
* **Onde fica**: Na raiz do workspace do card (`~/.vibe-kanban/worktrees/<card_id>/`).
* **O que editar**:
  * Gerado na Etapa 1 pelo agente Planner.
  * Você pode abrir e editar diretamente na aba de arquivos do workspace para ajustar regras ou requisitos antes que o Claude comece a codificar.

### 4. Prompts da Esteira (Pipelines)
* **Onde editar na UI**: ⚙️ **Settings ➔ Pipelines**.
* **Onde editar em arquivos**: `~/.vibe-kanban/pipelines/*.toml`.
* **O que colocar**: Prompts de persona, modelos atribuídos e flags de aprovação manual por etapa.

---

## 👥 3. Roster de Agentes Especializados

| Papel | Modelo / Executor | Atribuição Principal |
| :--- | :--- | :--- |
| **🧠 Arquiteto / PM** | `antigravity` (`gemini-2.5-pro`) | Análise global, RAG recall, desmembramento em sub-issues. |
| **📚 Pesquisador** | `agy-research` | Mapeamento de dependências, documentações e APIs externas. |
| **💻 Dev / Coder** | `claude` (`claude-3-7-sonnet`) | Implementação cirúrgica de código conforme a `SPEC.md`. |
| **🧪 QA / Tester** | `test-runner` / `local-executor` | Execução do Dev Server e suítes de testes (`cargo test`, `pnpm test`). |
| **🔍 Auditor / Review** | `codex` / `codex-review` | Análise adversarial de diff, linter e segurança contra a branch base. |

---

## 🛠️ 4. Servidor MCP do Vibe Kanban

Qualquer cliente de IA pode se conectar ao servidor MCP para orquestrar o quadro.

### Configuração no Cliente de IA (`mcp.json`):

```json
{
  "mcpServers": {
    "vibe-kanban": {
      "command": "aurapunk-mcp",
      "args": ["--mode", "global"],
      "env": {
        "VIBE_BACKEND_URL": "http://127.0.0.1:3002"
      }
    },
    "mem0": {
      "url": "http://127.0.0.1:8000/mcp"
    }
  }
}
```

### Ferramentas MCP Disponíveis para os Agentes:
* `create_issue(title, description, parent_issue_id, priority)`: Cria cards e sub-issues.
* `update_issue(issue_id, status="In Progress" | "Done")`: Move cards entre colunas.
* `get_issue(issue_id)` / `list_issues(project_id)`: Lê o conteúdo e checklists do card.
* `memory_search(query, limit?)` / `memory_save(fact)`: Consulta escopada (top-N por relevância, default 5) e salva fatos verificados no RAG `mem0`.
* `start_workspace(prompt, executor)`: Inicia um workspace para um agente filho.

---

## 🌳 5. Decomposição em Sub-Issues e Sub-Boards

1. **Top-Down (Planejamento)**:
   * O desenvolvedor cria uma issue de topo (ex: *"Sistema de Notificações"*).
   * O PM Agent analisa a issue e usa `create_issue` passando `parent_issue_id` para criar as sub-tarefas atômicas.
2. **Sub-Board View**:
   * No Kanban, ao abrir a issue pai, o botão **`Open Sub-Board`** abre um quadro exclusivo para as sub-tarefas daquele card.
3. **Bottom-Up (Resolução)**:
   * Conforme cada sub-tarefa é resolvida e testada, o progresso no card pai avança (`25%`, `50%`, `100%`).
   * Quando todas as sub-tarefas estiverem em `Done`, a issue pai é finalizada e mergeada.

---

## 🚦 6. O Gate de Preview ao Vivo (Dev Server) e Aprovação Manual

No arquivo `assets/pipelines/swarm-multi-agent.toml`, a etapa 4 é configurada como opcional:

```toml
[[stage]]
id = "manual-review"
label = "4. Manual Review & Live Preview (Dev Server) [Optional]"
default_enabled = false
prompt = "Boot workspace dev server, output preview URL, and pause for human operator review and approval."
```

* **Desmarcada**: O pipeline roda 100% autônomo até o merge e conclusão.
* **Marcada**: O pipeline pausa após o Review, sobe o Dev Server no Preview Proxy (porta `3003`), exibe o link ao vivo e só realiza o merge após o desenvolvedor clicar em **`[Approve & Merge]`**.

---

## 🔒 7. Padrão ADR-027: Swarm de Leitura Paralela e Execução Linear de Código

Para garantir **zero conflitos de Git** e eliminar riscos de agentes corrompendo arquivos simultâneos, o Vibe Kanban adota o padrão formalizado no [**ADR-027**](ADR/ADR-027-parallel-read-swarm-and-linear-execution.md):

1. **Fase 1: Paralelismo de Leitura (Swarm)**:
   * Múltiplos agentes leves (`Researcher`, `Codebase Inspector`, `RAG Recall`) rodam concorrentemente para ler e indexar o contexto sem risco de escrita.
   * O `Planner` consolida tudo na `SPEC.md`.
2. **Fase 2: Escrita Linear (Coder Especialista)**:
   * O `Claude 3.7 Sonnet` executa a implementação de código de forma linear e determinística.
3. **Fase 3: Relações de Bloqueio no Kanban (`IssueRelationshipType::Blocking`)**:
   * Sub-issues dependentes exibem o status `⏳ Bloqueada por #ID` e só são liberadas para execução quando as tarefas anteriores alcançarem `Done`.
