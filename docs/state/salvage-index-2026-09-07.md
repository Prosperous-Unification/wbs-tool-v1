# Salvage index — everything that was only on h1claw, 2026-09-07

Written at the repository owner's request: *"I want everything that is useful
work but uncommitted or unpushed to be pushed to PRs with clear reference to
task numbers."*

Every worktree on the box was scanned for uncommitted or unpushed content,
`node_modules` excluded. What was found is now on a remote branch. **None of it
is proposed for merge** — each entry says what it is, which task it belongs to,
and why it is or is not worth reviving. The point is that nothing valuable
depends on one VPS's disk any more.

## Preserved branches

| Branch | Task | What it holds |
|---|---|---|
| `wip/optimizer-terminal-minors-local-20260907` (`d7bcef41`) | **TASK-312**, **TASK-320** | 19 commits that had never been pushed anywhere: the optimizer admission write fence and its race tests, supervisor recovery ownership and races, `Retry` failure stamping from admission, bounded durable-recovery artifacts, a centralized durable poller Bun pin, real Docker cleanup edge coverage, and pruning of interrupted poller candidates |
| `wip/salvage-ws-auth-20260907` (`fcf5e1a8`) | **TASK-161** (PR #163, merged) | uncommitted edits to `docs/local-dev.md` and `docs/runbook-dev-deploy.md`, plus an untracked `openspec/changes/websocket-url-credentials/` |
| `wip/salvage-ws-auth-review-20260907` (`cd25c6a2`) | **TASK-161** review | 9 files, +59/−36, on a detached review checkout — presence panel, project stream, the gw-01 ws-auth integration test, and the change's `tasks.md`/`verify.md` |
| `wip/salvage-mermaid-export-20260907` (`333e8f2b`) | **TASK-R9 / mermaid export** (shipped in wave 6) | 6 files, +141/−121, on a branch **1,369 commits behind `main`** whose only commit is literally `wip` from 2026-08-14 |
| `wip/salvage-t267-b15-20260907` (`9449d2ee`) | **TASK-267** (done) | an `optimization-events.db.test.ts` addition and `work-item-deadline/tasks.md`. **Contains conflict markers** — the tasks.md was left in `UU` state and is committed exactly as found rather than resolved by guessing |
| `wip/salvage-mention-activedescendant-20260907` (`ff8e7aec`) | **TASK-104** (PR #146, merged) | 2 unpushed commits |
| `wip/salvage-t241-103-20260907` (`9bdf6e28`) | **TASK-241** (PR #279, merged) | 1 unpushed commit |
| `wip/salvage-task178-oidc-rollback-20260907` (`739932e9`) | **TASK-178** (PR #169, merged) | 1 unpushed commit |

## Reading these honestly

Six of the eight sit on branches whose PR is **merged**, so most of their
content already landed and what remains is post-merge residue. `git cherry`
will mark their commits as unlanded, but this repository squash-merges and
patch-id equivalence cannot see through a squash — that signal is not evidence.
Anything wanted from them has to be re-derived onto current `main` and
re-checked commit by commit.

Two are worth a second look rather than deletion:

- **`wip/optimizer-terminal-minors-local-20260907`** — the optimizer admission
  fence and the interrupted-poller-candidate pruning are deploy-loop relevant
  and had no remote copy at all until today.
- **`wip/salvage-ws-auth-review-20260907`** — a reviewer's working state that
  never reached a commit; `verify.md` changes in particular may record
  observations nothing else captured.

## Deliberately not touched

- **`/home/claw/wd/puni/wbs-tool-v1`** — a live worker checkout on
  `change/deadline-impossible-grid-description`. One untracked scratch file,
  `apps/fe-01/src/repro-theme.test.tsx`. Taking anything out of a checkout a
  lane is using is how TASK-346 lost an `LLM_README` edit to another lane's
  commit.
- **`wt-saved-plans-ui`** — 357 dirty files, but sitting on `main` rather than a
  feature branch. A stale checkout, not work in progress.
- **TASK-330's in-flight files in the workspace repo** —
  `ops/h2puni/reclaim-node-modules.sh`,
  `notes/h2puni-reclaim-headroom-proof-2026-09-07.sh` and
  `notes/host-h2puni-monitoring.md`, +105/−10. TASK-330 is `claimed` and commits
  every chunk; its last was 20:52Z. They are its work between chunks, not
  orphans, and absorbing them into a main-session commit is the exact shared
  checkout hazard `queue/WORKER.md` warns about.

## The workspace repo

`/home/claw/.openclaw/workspace` pushes directly to `main` by convention rather
than through PRs, so its salvage landed there instead: `f92e79c7` folded the
day's memory and dream corpus, and `4cf0369f` committed the uncommitted
superpowers plans and specs, `skills/executing-plans/SKILL.md`, and the review
artifacts for **TASK-241**, **TASK-261** and **TASK-327**.
