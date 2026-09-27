# Tutorial — Do zero ao Pull Request (na interface do app)

Este guia mostra, tela a tela, como um usuário configura o projeto, conecta o
Gitea e chega até o Pull Request — **usando só a interface do app**.

> Pré-suposto: o app já está no ar em **http://localhost:3001/**
> (se não estiver: rode `source "$HOME/.cargo/env" && pnpm run dev`).

---

## 1. Abrir o app

1. Abra o navegador em **http://localhost:3001/**
2. Na tela inicial você vê o **quadro Kanban** (colunas: Backlog → Ready →
   In Progress → Done) e o botão **+ Add repository** (canto superior).

---

## 2. Configurar o Gitea

1. Clique na engrenagem **⚙ Settings** (canto superior direito).
2. Role até o card **Gitea / Forgejo**.
3. Preencha:
   - **Base URL** — a URL da sua instância, **sem barra no fim**
     (ex.: `http://meuservidor:3000`)
   - **Default branch** — o branch principal (ex.: `main`)
4. Clique em **Save**.

### O token (fora do app)

O token **não** é digitado na tela. Ele fica em um arquivo, uma única vez:

```bash
mkdir -p ~/.aurapunk
cat > ~/.aurapunk/gitea.toml <<'EOF'
token = "cole-seu-token-aqui"
EOF
chmod 600 ~/.aurapunk/gitea.toml
```

> Gere o token no Gitea: *Perfil → Settings → Applications → Generate New Token*
> com escopo **repository**.

---

## 3. Adicionar o repositório

1. Fora da Settings, clique em **+ Add repository**.
2. Selecione a **pasta local** do repositório (clonada do seu Gitea), ou cole
   a URL do remote: `http://meuservidor:3000/usuario/repo.git`
3. Confirme.

> O app lê o `origin`, vê que o host é o seu Gitea e ativa o provider
> **Gitea** automaticamente (repositórios do GitHub continuam funcionando ao
> lado, sem conflito).

---

## 4. Criar a tarefa

1. No cartão da coluna **Backlog**, escreva a mudança que você quer
   (ex.: “Criar endpoint de health check que retorna JSON”).
2. Arraste o cartão para **Ready**.
3. Inicie a tarefa (botão/play no cartão).

---

## 5. O agente escreve o código

1. O app cria um **worktree** Git isolado (branch `vibe/...`) — seu `main`
   não é tocado.
2. O agente configurado implementa a mudança e vai **commitando** sozinho.
3. Acompanhe o **log em tempo real** na tela da tarefa.

---

## 6. Gerar o Pull Request

1. Quando o agente termina, a tarefa vai para a coluna **Done/PR**.
2. O app faz **push** da branch no Gitea e **abre o PR** sozinho.
3. O cartão exibe o **link do PR** — clique para revisar o diff.
4. No Gitea, revise e clique em **Merge** para mesclar.

> O monitor de PRs (roda a cada 60 s) atualiza o status do cartão sozinho
> (ex.: CI passou, PR foi mesclado).

---

## Resumo do clique a clique

```
localhost:3001 → ⚙ Settings → Gitea (base_url + default_branch) → Save
→ + Add repository (selecione a pasta / URL)
→ Backlog: escreva a tarefa → arraste para Ready → iniciar
→ (agente roda) → Done: cartão vira PR → abra o link → Merge
```
