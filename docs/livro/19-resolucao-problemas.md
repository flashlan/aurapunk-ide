# 19 — Resolução de problemas: índice de erros

**Objetivo:** sair do lugar em minutos quando algo quebra, em vez de
reinstalar tudo. Procure o sintoma, aplique a cura na ordem.

## 19.1 Git e merge

| Sintoma | Causa provável | Cura |
| --- | --- | --- |
| PR atrás do target, merge bloqueado | Branch desatualizada | Rebase antes do merge/push |
| Conflito no rebase/merge | Edições concorrentes | Resolva no painel Changes (diff lado a lado), marque resolvido, continue |
| Worktree "suja", comandos recusam | Mudanças não commitadas | Commit/stash na worktree antes de trocar de branch |
| Branch não aparece para worktree | Branch só existe local/abortada | Confira `git branch -a`; crie a partir do remoto |

Regra de bolso: rebase **antes** de abrir PR, quando o target andou e sempre
que o IDE pedir por estar atrás do target.

## 19.2 Preview e checks

| Sintoma | Causa provável | Cura |
| --- | --- | --- |
| Preview vazio | Sem script de dev no projeto | Configure `dev` em Projects & Repos (cap. 18) |
| Checks falhando | Lint/testes do repo | Rode `pnpm check` local, corrija, reenvie |
| Porta em uso (`AddrInUse`) | Processo antigo vivo | Localize com `lsof -i :PORTA` e encerre |

## 19.3 Banco local e logs

| Sintoma | Causa provável | Cura |
| --- | --- | --- |
| Estado estranho/impeditivo | Banco local corrompido | **Último recurso:** apague o SQLite do app e reabra (ver abaixo) |
| Comportamento sem explicação | Falta evidência | `RUST_LOG=debug npx aurapunk-ide` e leia o log |
| Codebase vazia no workspace | Sparse-checkout agressivo | Desative o checkout esparso do repo |

> **Apagar o banco local** remove projetos, issues e histórico daquela
> máquina (o sync pode trazer de volta o que estava sincronizado). Localize
> o `db.v2.sqlite` no diretório de dados do app
> (`~/.local/share/vibe-kanban/` no Linux) e remova com o IDE **fechado**.
> Nunca faça isso com trabalho não commitado nas worktrees.

## 19.4 Quando pedir ajuda

Anote sempre: versão (`npx aurapunk-ide --version`), SO, agente e modelo,
o erro literal e os últimos 30 linhas do log com `RUST_LOG=debug`. Com isso,
metade dos casos se resolve sozinha na leitura.
