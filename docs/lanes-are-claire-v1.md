# Lanes are Claire's first-version SDLC enabler — 2026-09-16

A **lane** is one Claire worker session, working in its own worktree of this
repository — every worktree on a single `.git`. Gating is the exception: the
lanes share one tree on h2puni, so a lane proves its work through
`bin/h2puni-gate.sh <sha>`, which takes the canonical host-wide heavy lock and
checks that exact SHA out under it.

Lanes are a mechanism, not an architecture. They are the first version of an
SDLC that lets several agents work this repository at once, and they exist
because the alternative — agents sharing one checkout and one port range —
produced gate results about heads nobody asked about
([the agent loop, audited](2026-08-30-agent-loop-audit.md)). **Expect the
mechanism to be replaced.** Nothing here should grow a dependency on lane names,
lane counts or the queue's file layout. What must survive a replacement is the
three contracts below, each written for a failure that was watched.

## The three contracts a lane honours

- **Gate the exact SHA, under the lock.** Call `bin/h2puni-gate.sh <sha>` and
  trust the printed `h2puni gate: running on <sha>`, not intent; the refusals and
  the rest of the rule are in [AGENTS.md, _Gate_](../AGENTS.md#gate).
- **Never commit inside another lane's worktree.** Stage an explicit path list
  and say which modified files were left alone; `git add -A` in a tree another
  lane is using stages that lane's in-flight work under your task.
- **Own your ports.** A lane that reuses another lane's port shift measures the
  other lane's servers, and the number it reports says nothing about its own
  head. `bin/dev-ports.sh` refuses a dev stack whose ports are already served.

## Where the mechanism lives

Claire's half is a set of scripts outside this repository, under
`~/wd/personal/claire/bin/`: `lane-registry.mjs` (what a lane's worker job must
look like), `lane-guard.mjs` and `lane-commit.mjs` (the commit contract, as a
pre-commit refusal and as the sanctioned commit path), `queue-worktree.mjs` (the
lane-owned worktree and its claim), and `queue-dispatch.mjs`,
`queue-dispatch-backstop.mjs`, `queue-claim-check.mjs`,
`queue-backstop-alarm.mjs`, `queue-lane-health.mjs`, `queue-report.mjs` and
`queue-status-relay.mjs` (dispatch, its backstops, health and status). This
repository holds none of them — only the contracts they have to satisfy.
