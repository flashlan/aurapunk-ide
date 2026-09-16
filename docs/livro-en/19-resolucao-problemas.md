# 19 — Troubleshooting: error index

**Goal:** get unstuck in minutes instead of reinstalling everything. Find
the symptom, apply the fix in order.

## 19.1 Git and merge

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| PR behind target, merge blocked | Stale branch | Rebase before merge/push |
| Conflict on rebase/merge | Concurrent edits | Resolve in the Changes panel (side-by-side diff), mark resolved, continue |
| "Dirty" worktree, commands refused | Uncommitted changes | Commit/stash in the worktree before switching branches |
| Branch missing for worktree | Branch only local/aborted | Check `git branch -a`; create from the remote |

Rule of thumb: rebase **before** opening a PR, when the target moved, and
whenever the IDE asks for being behind target.

## 19.2 Preview and checks

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Empty Preview | No dev script on the project | Set `dev` in Projects & Repos (ch. 18) |
| Failing checks | Repo lint/tests | Run `pnpm check` locally, fix, resend |
| Port in use (`AddrInUse`) | Old process alive | Find it with `lsof -i :PORT` and stop it |

## 19.3 Local database and logs

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Strange/blocking state | Corrupt local DB | **Last resort:** delete the app SQLite and reopen (see below) |
| Unexplained behavior | Missing evidence | `RUST_LOG=debug npx aurapunk-ide` and read the log |
| Empty codebase in workspace | Aggressive sparse-checkout | Disable the repo's sparse checkout |

> **Deleting the local database** removes that machine's projects, issues,
> and history (synced content can come back via sync). Locate `db.v2.sqlite`
> in the app data dir (`~/.local/share/vibe-kanban/` on Linux) and remove it
> with the IDE **closed**. Never do this with uncommitted work in worktrees.

## 19.4 When asking for help

Always note: version (`npx aurapunk-ide --version`), OS, agent and model,
the literal error, and the last 30 log lines with `RUST_LOG=debug`. Half the
cases solve themselves on reading.
