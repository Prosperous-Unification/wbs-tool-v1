## Why

`with_heavy_lock` polls `mkdir` every five seconds, so a released lock goes to whichever waiter
polls first: a browser gate on h2puni waited 50 minutes while four later jobs took it ahead of
them (agent loop audit, item 12). Nothing reports who holds the lock or waits, so a starved lane
looks like a slow one.

## What Changes

**Service order**

- From: a released lock goes to whichever waiter polls first.
- To: waiters take it in arrival order.
- Impact: **breaking for wait-0 callers**, deliberately. `HEAVY_LOCK_WAIT_SECONDS=0` is the
  default, so `bin/with-heavy-lock.sh` (`test:queued`, `publish-release.sh`) is now refused 75
  while a live ticket is ahead of it, even with the lock free — that instant is the lottery. Such a
  caller queues by setting a budget.

**Queue observability** — new, non-breaking: `bin/with-heavy-lock.sh status` prints the holder's
pid and lane label, then each waiting ticket oldest first with age and budget; a claim prints
`heavy lock: waited <n>s behind <k> tickets`; a refusal names who is ahead; the gate labels its
lane `gate:<sha>`.

**Dead waiters** — new: a ticket whose pid is gone, or whose budget expired, is removed by whoever
sees it, named on stderr.

## Non-Goals

One lane: no priority classes, no fairness beyond arrival order. No lock path override — its
absence stops a caller opting out of the lock. No cross-host lock.

## Constraints

Bash 3.2, no new dependency. 75 contention and 70 unknown state keep their meanings; 64 (invalid
poll) and 130/143 (signalled) are new. Every new check ships a watched negative.

- assumed: no design interview was held; the controller ruled on these.
- assumed: the queue is `<lock path>.queue`, reached through the path argument, never an
  environment variable.
- assumed: tickets order by `date +%s%N` (Darwin: `python3 time.time_ns`), pid breaking ties.
- assumed: `<n>` is whole seconds from enqueue to claim, `<k>` the tickets ahead at enqueue.
- assumed: a ticket is dead when its pid is gone or its budget expired over a minute ago; pids
  are recycled, so `kill -0` alone queues lanes behind ghosts.

## Capabilities

### New Capabilities

- `heavy-lock-queue`: arrival order, observability and dead-waiter reclaim for the heavy lock.

### Modified Capabilities

None.

## Domain Terms

`Ticket`, `Lane label` — defined in `CONTEXT.md`.

## Decisions Recorded

None. The queue is reversible.

## Impact

`bin/heavy-lock-lib.sh`, `bin/with-heavy-lock.sh`, `bin/h2puni-gate.sh`, their tests, every agent
lane on h2puni. No application or deploy path.
