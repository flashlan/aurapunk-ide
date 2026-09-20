# mem0-vk

Camada de memória compartilhada para agentes de código — MCP (Streamable-HTTP) + REST, Qdrant, grafos opcionais. Zero GPU: embeddings locais por sentence-transformers (CPU).

## Instalação mais simples — Docker Hub all-in-one

A imagem `datyapoint/vk-mem0` inclui a API, Qdrant, Redis, embeddings locais e o grafo NetworkX. Para a extração você pode usar uma chave de um provedor em nuvem (Groq, OpenRouter, OpenAI, Llama) **ou** a Laya local, que roda em uma **imagem separada** (veja *Laya (motor de decisão)* abaixo):

```bash
docker run -d \
  --name vk-mem0 \
  --restart unless-stopped \
  -p 8000:8000 \
  -e GROQ_API_KEY='sua-chave' \
  -v vk_mem0_data:/data \
  datyapoint/vk-mem0:latest
```

Na primeira inicialização, aguarde o healthcheck carregar o modelo local:

```bash
docker ps --filter name=vk-mem0
curl http://localhost:8000/health
```

Para fixar uma versão, substitua `latest` por uma tag como `0.2.43`. Você também pode usar o Compose pronto para Docker Hub:

```bash
cd mem0-vk
export GROQ_API_KEY='sua-chave'
docker compose -f docker-compose.hub.yml up -d
```

Todos os dados persistentes ficam no volume `vk_mem0_data`. As portas internas de Qdrant, Redis e embeddings não são publicadas no host.

A tela **Settings → Memory** continua funcionando com esta imagem: ela lê e grava a configuração pela API `/api/config`, persistida em `/data/config.json`. Essas chaves selecionam o LLM que extrai fatos e relações (Groq, OpenRouter, OpenAI ou Llama). Os embeddings não precisam de chave porque o modelo local já está incluído na imagem.

### Laya (motor de decisão)

A Laya **não** vem nesta imagem — ela é publicada separadamente como `datyapoint/vk-laya` (o Dockerfile fica em `packages/jev-plugin/docker`), roda o modelo `convaiinnovations/laya` (System-1 ModernBERT) e serve `POST /predict` (ver a seção 7 do README do plugin). A extração de memória pode usá-la no lugar de um LLM em nuvem:

```bash
docker run -d --name laya-local --restart unless-stopped -p 8080:8080 datyapoint/vk-laya:latest

docker run -d --name vk-mem0 --restart unless-stopped -p 8000:8000 \
  -e MEM0_LLM_PROVIDER=laya \
  -e MEM0_LAYA_URL=http://host.docker.internal:8080 \
  -v vk_mem0_data:/data datyapoint/vk-mem0:latest
```

- De dentro do container, use `host.docker.internal` (Docker Desktop/OrbStack) ou o nome do container numa rede compartilhada — `127.0.0.1` seria o próprio container do mem0.
- O **app desktop** fala direto com esse mesmo container Laya (Settings → Laya execution mode: docker, `http://localhost:8080`).
- Se a Laya falhar ou estourar o timeout (~20 s), a extração cai no extrator determinístico de 0 tokens — nunca bloqueia uma gravação.
- A Laya carrega o modelo em memória (~3 GB) e é CPU-only: em máquinas com 8 GB, rode-a sozinha (não junto de outra cópia da Laya).

### API authentication and hosted license checks

All app-to-Mem0 traffic uses the same REST/MCP contract. Set `MEM0_API_TOKEN`
to require `Authorization: Bearer <token>` on every request except `GET
/health`. Configure the same token in the Vibe Kanban backend (or MCP
environment) and in this service. Leaving it empty keeps an intentionally open
local development install backwards-compatible.

For a hosted Mem0 service, also set `MEM0_LICENSE_CHECK_URL` and
`MEM0_LICENSE_CHECK_TOKEN`. Memory operations then require the caller to send
`X-AuraPunk-Account-Id`; Mem0 calls the license endpoint and accepts the
request only when it returns `{"active":true}`. Hosted memory namespaces are
automatically prefixed by the account ID, so accounts cannot share a repo slug
by accident. The license endpoint must be private and must validate the active
subscription in the account database.

### Atualização segura

Para atualizar uma instalação all-in-one, reutilize o mesmo volume `/data`. Remover o container não remove o volume:

```bash
docker pull datyapoint/vk-mem0:latest
docker rm -f vk-mem0
docker run -d --name vk-mem0 --restart unless-stopped -p 8000:8000 \
  -v vk_mem0_data:/data datyapoint/vk-mem0:latest
```

Não use `docker volume rm`, `docker volume prune` ou `docker compose down -v` durante uma atualização.

Para migrar da instalação Compose antiga, faça backup dos volumes `mem0-vk_graph_data`, `mem0-vk_qdrant_data` e `mem0-vk_redis_data`, execute `docker compose down` (sem `-v`) e monte-os assim:

```bash
docker run -d --name vk-mem0 --restart unless-stopped -p 8000:8000 \
  -v mem0-vk_graph_data:/data \
  -v mem0-vk_qdrant_data:/data/qdrant \
  -v mem0-vk_redis_data:/data/redis \
  datyapoint/vk-mem0:latest
```

O rollback é reversível: remova apenas o container all-in-one e inicie novamente o Compose original, mantendo os três volumes.

## Arquitetura

```
                          ┌──────────────────────────────────────┐
   ~10 CLI agents (vk)    │  Container 1: mem0-vk (Node 20)      │
                          │  ┌────────────────────────────────┐  │
 ┌──────────────┐  /mcp   │  │ MCP Streamable-HTTP  (Hono)    │  │
 │ Qwen Code    │────────▶│  ├────────────────────────────────┤  │
 │ Claude Code  │  /api/* │  │ REST  /api/memories …          │  │
 │ Codex        │────────▶│  ├────────────────────────────────┤  │
 │ opencode …   │         │  │ resolvers:                     │  │
 └──────────────┘         │  │  • LLM extração (1 ativo)      │  │
                          │  │  • embeddings (fallback 4)     │  │
                          │  └──────┬──────────────┬──────────┘  │
                          └─────────┼──────────────┼─────────────┘
                                   ▼              ▼
                          ┌──────────────┐  ┌─────────────────────────────┐
                          │ Qdrant       │  │ Container 2 (Python, opc.)  │
                          │ (vectors)    │  │ sentence-transformers (CPU) │
                          │ user_id/repo │  │ NetworkX graph              │
                          └──────────────┘  └─────────────────────────────┘
```

- **Container 1 (`mem0-vk`)** — o endpoint. Expõe MCP e REST sobre a MESMA memória Qdrant, particionada por `user_id` (slug do repo).
- **Qdrant** — store de vetores; um ponto por fato, com payload `{content, user_id, created_at, entities, relations}`.
- **Container 2 (Python, opcional)** — sentence-transformers em CPU servindo `/v1/embeddings` (formato OpenAI) + API de grafos NetworkX. Enquanto não existe, o sistema roda em modo vector-only com qualquer backend de embedding configurado.
- **Redis (fila BullMQ)** — `POST /api/memories` (e a tool MCP `memory_store`) não roda mais a extração LLM + embedding na própria request: enfileira o job e responde `202 Accepted` na hora. Um worker no mesmo processo Node consome a fila em background. Isso evita bloquear o agente chamador durante o round-trip até o provedor LLM, e a fila é durável (sobrevive a um restart do container mem0-vk no meio de um job) — importante rodando num servidor compartilhado por vários agentes concorrentes. `GET /api/memories/jobs/:jobId` consulta o status de um job (debug only — chamadores normais não precisam fazer polling).

## Como o isolamento por repo funciona

Cada repo tem um slug (ex.: `kiky-android`, `kiky-ocr`) definido no AGENTS.md. Os agentes passam esse slug como `user_id`. O server **nunca** injeta o `user_id` sozinho — quem chama sabe em que repo está rodando.

```
memory_store("Android usa Kotlin", "kiky-android")
memory_store("Python usa tipagem dinâmica", "kiky-ocr")
memory_search("tipagem", "kiky-ocr")  → só retorna de kiky-ocr
```

## Quick Start

### 1. Inicie o Docker (se o daemon estiver parado)

| Runtime | Comando | Aguarde |
|---|---|---|
| OrbStack (macOS) | `open -a OrbStack` | ~5 s |
| Docker Desktop (macOS) | `open -a Docker` | ~15–30 s |
| Linux (systemd) | `sudo systemctl start docker` | imediato |

Confira que o daemon está no ar:

```bash
docker info >/dev/null && echo "daemon ok"
```

### 2. Suba os containers

```bash
cd mem0-vk
export GROQ_API_KEY=gsk_...        # ou outro provider (ver tabela abaixo)
docker compose up -d --build
docker compose ps                 # qdrant e mem0-vk devem estar "Up"
```

Saúde:

```bash
curl localhost:8000/health
curl localhost:8000/               # índice de endpoints + status
```

### REST

```bash
# armazenar
curl -X POST localhost:8000/api/memories \
  -H 'content-type: application/json' \
  -d '{"content":"O build usa ./gradlew assembleDebug","user_id":"kiky-android"}'

# buscar
curl -X POST localhost:8000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"como fazer build","user_id":"kiky-android"}'

# listar tudo de um repo (resposta inclui prompt_block — ver "Injeção no prompt")
curl localhost:8000/api/memories/kiky-android

# atualizar
curl -X PATCH localhost:8000/api/memories/<memory_id> \
  -H 'content-type: application/json' \
  -d '{"content":"O build usa ./gradlew bundleRelease","user_id":"kiky-android"}'

# apagar um ponto (UUID)
curl -X DELETE localhost:8000/api/memories/<memory_id>

# apagar tudo de um repo (qualquer string que não seja UUID = user_id)
curl -X DELETE localhost:8000/api/memories/kiky-android
```

### MCP (Streamable-HTTP)

Configuração para hosts MCP com suporte HTTP (Qwen Code, Claude Code, Cursor, opencode…):

```json
{
  "mcpServers": {
    "mem0": {
      "type": "streamableHttp",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

Tools expostas: `memory_store`, `memory_search`, `memory_recall`, `memory_update`, `memory_forget`.

> **Nota:** o Codex só suporta MCP via stdio — para ele, use a API REST (mesma memória, mesmo Qdrant).

## Injeção no prompt (KV-cache friendly)

`memory_recall` (MCP) e `GET /api/memories/:user_id` (REST) retornam as memórias **já formatadas** num bloco pronto para injetar:

```
--- project memories (3) — inject after stable prefix to keep KV cache ---
- O build usa ./gradlew assembleDebug
- Qdrant roda na porta 6333
- Pipeline: ocr → re-image → re-document
```

Estrutura de prompt recomendada (mantém o prefixo estável e preserva o cache de KV do LLM):

```
{system_message}          ← prefixo estável
{conversation_history}    ← prefixo estável
{prompt_block}            ← memórias SEMPRE no fim, após o prefixo
```

Se as memórias forem injetadas no **início** do prompt, o prefixo muda a cada request e o cache de KV quebra. Injetando no **fim**, o prefixo fica idêntico entre turns e o cache é reaproveitado.

## Variáveis de ambiente

### Server

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Bind address |
| `QDRANT_URL` | `http://qdrant:6333` | URL do Qdrant |
| `MEM0_COLLECTION` | `mem0-vk` | Nome da collection |
| `MEM0_DEFAULT_USER` | `default` | `user_id` quando o caller não envia |
| `EMBED_DIM` | `768` | **Deve casar** com o dim do backend de embedding vencedor |
| `REDIS_URL` | `redis://localhost:6379` (`redis://redis:6379` no compose) | Fila durável (BullMQ) do `memory_store` em background |

### LLM de extração (1 ativo, via `MEM0_LLM_PROVIDER`)

| Provider | Variáveis | Modelo padrão |
|---|---|---|
| `groq` (padrão) | `GROQ_API_KEY`, `GROQ_MODEL` | `llama-3.3-70b-versatile` |
| `openrouter` | `MEM0_OPENROUTER_KEY`, `MEM0_OPENROUTER_MODEL` | `nvidia/nemotron-3-nano-30b-a3b:free` |
| `llama` | `MEM0_LLAMA_URL`, `MEM0_LLAMA_KEY`, `MEM0_LLAMA_MODEL` | — |

Se o LLM falhar, a extração faz fallback para o texto bruto (1 fato = texto inteiro).

### Embeddings (fallback em ordem; primeiro com sucesso vence)

| Ordem | Backend | Variáveis |
|---|---|---|
| 1 | local (sentence-transformers, CPU) | `EMBED_LOCAL_URL`, `EMBED_LOCAL_MODEL` |
| 2 | llama-server | `EMBED_LLAMA_URL`, `EMBED_LLAMA_MODEL`, `EMBED_LLAMA_KEY` |
| 3 | OpenAI | `OPENAI_API_KEY`, `EMBED_OPENAI_MODEL` |
| 4 | OpenRouter | `EMBED_OPENROUTER_KEY`, `EMBED_OPENROUTER_MODEL` |

Todos os backends falam formato OpenAI: `POST {base}/embeddings` com `{model, input: [text]}`.

**Dimensões comuns:**

| Modelo | Dim |
|---|---|
| `sentence-transformers/all-MiniLM-L6-v2` | 384 |
| `nomic-embed-text` | 768 |
| `text-embedding-3-small` | 1536 |

Se a dim do backend não casar com `EMBED_DIM`, ele é rejeitado e o fallback continua.

### Grafos (opcional)

| Variável | Descrição |
|---|---|
| `GRAPH_URL` | Base URL do container Python com a API de grafos. Vazio = vector-only. |

Endpoints esperados no container Python (todos com `user_id` no body para isolamento):

```
POST /graph/upsert        {user_id, entities:[{name,type,description}], relations:[{subject,predicate,object}]}
POST /graph/neighbors     {user_id, query} → [{name, description, score}]
POST /graph/relations     {user_id, query} → [{subject,predicate,object}]
POST /graph/remove_node   {user_id, name}
POST /graph/remove_user   {user_id}
```

## Comandos

```bash
docker compose up -d          # iniciar (dados persistem)
docker compose down           # parar
docker compose down -v        # parar + apagar Qdrant
docker compose logs -f        # logs
docker compose ps             # status
```

## Estrutura

```
mem0-vk/
├── src/
│   └── index.ts                    # endpoint: MCP + REST + resolvers + proxy de grafos
├── test/
│   ├── harness.ts                  # boot/teardown compartilhado (stub e embedding real)
│   ├── test.ts                     # smoke test HTTP (REST + MCP), embedding stub
│   ├── context-drift.test.ts       # perda/drift de contexto no handoff, embedding stub
│   ├── semantic-recall.test.ts     # recall semântico real (embedding real, sem custo)
│   └── extraction-quality.test.ts  # qualidade da extração LLM real (localhost:8000, groq/etc.)
├── embeddings/          # container Python sentence-transformers (CPU) + grafo NetworkX
├── Dockerfile           # Node 20 slim, EXPOSE 8000
├── docker-compose.yml   # qdrant + mem0-vk + embeddings
├── package.json
├── tsconfig.json
└── README.md
```

## Testes

```bash
npm run build

npm test              # smoke test HTTP+MCP (stub — sem custo, sem chaves)
npm run test:drift    # mecanismo de ranking/dedup/cap sob ruído sintético (stub)
npm run test:semantic # recall real (embeddings/ sidecar — grátis, CPU local)
npm run test:extraction # qualidade da extração de entidades/relações (LLM real — precisa de chave configurada)
```

`test`, `test:drift` e `test:semantic` são auto-contidos (sobem seu próprio processo isolado) e não precisam de chaves de API. `test:extraction` bate direto no container já rodando em `localhost:8000` — pula (não falha) se o container não estiver de pé ou sem provedor de extração configurado.

## Licença

MIT
