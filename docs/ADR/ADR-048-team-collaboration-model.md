# ADR-048: Team collaboration model (Cloud teams, PR integration, role-based stages)

## Status

Proposed

## Date

2026-09-27

## Context

AuraPunk is a single-operator, local-first product (ADR-004) with a private
Cloud that already owns accounts, billing and hosted memory (ADR-040). The
kanban + pipeline + multi-agent model maps naturally onto a team of people who
each drive their own agents. The open questions were: whether the open-source
core should become multi-user, how code produced by several people and their
agents is integrated, and how work is delegated across roles (developers,
engineers/reviewers, QA).

Integrating code inside AuraPunk across machines would mean re-implementing a
Git host (reviews, CI, permissions, audit). Teams already have one.

## Decision

1. **The open-source core stays single-operator.** Team coordination —
   members, roles, shared boards, assignment, team memory, billing — lives in
   AuraPunk Cloud. Anything also useful to a solo user is added to the core as
   a provider-neutral interface first (ADR-040), notably the PR integration
   mode.

2. **Pull requests are the integration boundary for teams.** Integration
   Guard gains a per-project mode:
   - `local` (today): verify → squash-merge into the target branch;
   - `pull_request`: verify (tests, diff checks) → push the branch → open a PR
     through `git-host` → the card tracks the PR (review requested, checks,
     merged). ADR-046 generalizes to "integrated = PR merged".

3. **Execution stays local and owned** (ADR-047): each member runs their own
   Desktop (or a Cloud instance) with their agents; a workspace belongs to the
   instance that runs it.

4. **Delegation is assignment + claim.** A card is assigned to a member (or
   role); that member's instance claims it atomically through the Cloud
   command queue (ADR-047 phase 3). The PM/orchestrator agent may propose
   assignments; a human approves.

5. **Roles are pipeline stages.** Each stage may carry a role and an assignee
   and an optional approval gate:

   ```text
   Implement ──► Review ──► QA ──► Done (PR merged)
   developer     engineer   QA
   + own agents  + agent    + preview proxy
   ```

   Agents make a first pass (the `review` crate, QA agents); a human in the
   stage's role approves or sends the card back.

### Roadmap

| Phase | Deliverable |
|---|---|
| T0 | ADR-047 phases 2–5: reliable multi-writer sync (outbox, command queue, `scope_id`, `base_revision`) |
| T1 | Cloud teams: members and roles (owner, maintainer, developer, QA, viewer); shared board per `scope_id` |
| T2 | Card assignment and claim; "my cards" per Desktop; per-member notifications (push/Telegram) |
| T3 | `pull_request` integration mode in the public core; card follows the PR |
| T4 | Role/assignee/approval gates on pipeline stages |
| T5 | Team-scoped Mem0 with ACL |

## Consequences

- Solo users keep the complete product without an account; teams pay for
  coordination, not for features removed from the local product.
- No distributed merge machinery in AuraPunk; review, CI and permissions come
  from the team's Git host.
- T1+ depends on T0: without multi-writer sync guarantees a team would lose
  edits (two instances already overwrite each other today).
- A community fork could add team features to the core; the defensible value
  is the hosted coordination, memory and compute, not the code.
