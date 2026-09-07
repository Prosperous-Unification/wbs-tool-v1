# Dev deploys itself from origin/main, again

A poller on h2puni (`/home/puni1/wbs-dev/bin/poll.sh`, puni1's crontab, every minute)
fetches `origin/main` and, when it has moved, runs the checkout's own
`tools/tool-devsync/src/sync.ts` against the new SHA. Dev is therefore whatever `main`
is, within about a minute, with no human step. Prod is untouched and stays a deliberate
manual deploy (2026-08-06 call).

**This reverses a deletion, and the deletion was right when it was made.** wbs had a
poller (`trigger.ts`); it was removed on 2026-08-04 in `9b666f7` because every push
originated with a human at a terminal on h1claw, who could type `git push && bin/sync.ts`
in one breath. Polling for a change you just made yourself is a machine asking a question
it already knows the answer to.

That premise died on 2026-08-19, when queue workers were given standing authority to
merge their own green PRs. The merge commit is now created on GitHub by `gh pr merge` and
lands on `origin/main` without ever existing on any machine that could deploy it. The
result was not theoretical: on the night of 2026-08-21 the `tags-qa` task finished its
first walk, filed a defect, saw the fix merged — and then could not re-check it, because
dev was three merges behind and the only way forward was a human running one command.
The task recorded `blocked` and stopped. Nothing was wrong with the code, the tests, the
CI or the merge; the loop simply had a gap exactly where nobody was awake.

## How it verifies, and what it can prove

`be-01`'s `/health` reports `commit` — the object name the checkout on disk is at, read
from the refs on every call rather than captured at startup. It is read per call because
the deploy is a `git reset --hard` under live watchers (`bun --watch`, Vite HMR): a
commit that touches no watched module moves the tree and restarts nothing, so a value
captured at boot would report the previous deploy for as long as the process happened to
live — and a docs-only commit is precisely the kind whose landing is otherwise invisible.

The poller reads `/health` from inside the container, so it goes to be-01 directly rather
than through the basic auth at the edge, and it reads repeatedly until the served commit
matches or a minute of attempts is out. A checkout that moved but a process that has not
caught up prints a different line from a deploy that succeeded — the two must not look
the same, and an earlier deploy on this host was nearly signed off on a single read that
happened to agree with the state it was trying to leave.

## Consequences

`main` is continuously deployed to dev. A merge that breaks dev breaks it for everyone
looking at dev, within a minute, with no gate beyond the CI that let the merge happen.
That is the trade accepted: CI green is already the merge gate for PoC-mode work, and dev
exists to be looked at rather than to be relied on.

The poller lives outside the checkout because it resets the checkout — a script inside a
tree it hard-resets is a script editing itself mid-run, and bash reads a file by offset as
it goes. Before 2026-09-07 it nevertheless ran the checkout's pre-reset `sync.ts`; a
preflight defect could therefore prevent the repaired tool from ever landing. The durable
poller now extracts `sync.ts` from the fetched target commit into a commit-named
`/home/puni1/wbs-dev/bin/sync.<sha>.ts` candidate and executes it. A broken candidate
can refuse its own deploy, while its repaired successor is available on the next tick.
Solver, restart, recreate and post-reset checks still run inside the extracted tool.
