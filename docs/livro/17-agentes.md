# 17 — Agentes: instalação, autenticação e modelos

**Objetivo:** deixar pelo menos um agente de codificação instalado, autenticado
e selecionável dentro do AuraPunk IDE antes do primeiro workspace de verdade.
Sem isso, o workspace abre, mas nenhum executor assume a tarefa.

> Regra de ouro deste capítulo: o agente mora **fora** do AuraPunk IDE (é um
> CLI instalado na sua máquina). O IDE apenas o detecta e o dirige. Se o
> agente não aparece no dropdown do workspace, o problema está na instalação
> ou no `PATH`, nunca no board.

## 17.1 O ciclo de vida de um agente no IDE

1. **Instale o CLI** do agente (seção 17.2).
2. **Autentique** (login interativo ou variável de ambiente com API key).
3. Abra o AuraPunk IDE (`npx aurapunk-ide`) e crie um workspace.
4. Escolha o agente no dropdown do chat. O IDE lembra a última escolha.

## 17.2 Tabela de instalação e autenticação

| Agente | Instalação | Autenticação |
| --- | --- | --- |
| Claude Code | `npx -y @anthropic-ai/claude-code` | Login interativo guiado |
| OpenAI Codex | `npx -y @openai/codex` | Plano ChatGPT **ou** `OPENAI_API_KEY` |
| GitHub Copilot | `npx -y @github/copilot` | Comando `/login` no CLI |
| Gemini CLI | `npx -y @google/gemini-cli` | Login interativo guiado |
| Amp | `npx -y @sourcegraph/amp` | Login interativo (ver manual do Amp) |
| Cursor Agent | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` ou `CURSOR_API_KEY` |
| OpenCode | `npx -y opencode-ai` | Login interativo guiado |
| Factory Droid | `curl -fsSL https://app.factory.ai/cli \| sh` | `/login` no CLI ou `FACTORY_API_KEY=fk-...` |
| Qwen Code | `npx -y @qwen-code/qwen-code` | Login interativo guiado |
| CCR (roteador) | `npx -y @musistudio/claude-code-router ui` | Configure providers na UI do CCR |

Detalhes que evitam as armadilhas mais comuns:

- **Codex com diretório customizado:** se você usa `CODEX_HOME` para separar
  perfis (pessoal × trabalho), o IDE detecta e respeita automaticamente.
  ```bash
  export CODEX_HOME=/caminho/do/codex-projeto
  npx aurapunk-ide
  ```
- **Cursor:** confira com `cursor-agent --version` antes de abrir o IDE.
- **Droid no Windows:** `irm https://app.factory.ai/cli/windows | iex`; a
  chave alternativa sai em `app.factory.ai/settings/api-keys`.
- **CCR não é da Anthropic:** é um roteador de terceiros que distribui
  prompts entre provedores e modelos (contexto longo, background, imagens).
  Útil para paralelizar vários workspaces sem fila.

## 17.3 Perfis de agente: planejar, permissões e modelos

Em **Settings → Agents** você cria variantes reutilizáveis por agente
(modelo, planning mode, permissões, sandbox, variáveis de ambiente). A
configuração padrão já vem pré-selecionada no dropdown do chat. Receitas:

| Caso | Configuração |
| --- | --- |
| Iteração rápida | Planning mode desligado, modelo leve |
| Tarefa complexa | Planning mode ligado, modelo avançado |
| Trabalho autônomo | Pular prompts de permissão (com cautela) |
| Revisão de código | Aprovações ligadas para toda mudança |
| Paralelismo | CCR distribuindo instâncias |

Conceitos que valem o minuto de leitura:

- **Planning mode:** o agente escreve o plano antes do código; você aprova a
  estratégia. Ótimo para tarefas complexas, overhead para as simples.
- **Permission prompts:** o agente pede confirmação antes de ações
  destrutivas (apagar arquivos, shell, configs de sistema). Pular tudo
  (`dangerously_skip_permissions`) remove as travas — use com cautela.
- **Sandbox (Codex):** `read-only` (só lê), `workspace-write` (só o projeto),
  `danger-full-access` (sem restrições).
- **Approval levels:** definem quando o agente pausa para sua confirmação.

## 17.4 Verificação e problemas comuns

1. Rode o CLI no terminal (`claude --version`, `codex --version` etc.).
2. Se o comando não existe, reinstale e **reinicie o terminal** (é o `PATH`
   desatualizado em 9 de 10 casos).
3. Abra o IDE e confira o dropdown do workspace.
4. Teste com um prompt trivial antes da tarefa real.

Se o agente some do dropdown depois de funcionar: confira se a variável de
ambiente da chave (`OPENAI_API_KEY`, `CURSOR_API_KEY`, `FACTORY_API_KEY`…)
continua exportada na sessão onde o IDE foi lançado.
