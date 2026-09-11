# Runbook — deploying dev

**Dev is whatever `origin/main` is, within about a minute, with no human step.** A poller
on h2puni (`/home/puni1/wbs-dev/bin/poll.sh`, puni1's crontab, every minute) fetches
`origin/main` and resets the checkout to it when they differ —
`docs/adr/0005-dev-deploys-itself-from-origin-main.md`. So the deploy for a merged commit
is the merge.

**A branch cannot be deployed to dev.** The poller resets the checkout back to `main`
within 60 seconds, and `bin/dev-deploy.sh` prints `dev healthy at <sha>` before that
happens. Watched 2026-08-31: a branch landed at 15:26:58, the poller pulled dev back at
15:27:02, and the `apps/be-01/drizzle` change it carried never applied — be-01's restart
lost the race to the revert **by about a second**, which is luck rather than a guarantee.
Had it won, dev's database would hold a migrated schema while dev's code was back on the
commit before it.

`bin/dev-deploy.sh` is still the way to push a commit that is _already on main_ without
waiting for the next poll tick, and to watch the output while it happens:

```sh
git push && ./bin/dev-deploy.sh
```

Everything below is what that command does, and what it cannot do.

**Dev does not use any of the below.** Since 2026-08-04 dev runs from source, and since
2026-08-19 it deploys itself from `origin/main` (ADR 0005):

```sh
git push && ./bin/dev-deploy.sh     # a commit on main, when you will not wait for the poller
```

`bin/dev-deploy.sh` refuses a dirty tree or an unpushed SHA, then asks h2puni to
`git reset --hard` its checkout at `/home/puni1/wbs-dev/src`. That checkout is bind-mounted
into one container, `wbs-dev-src`, running all three tiers via `bun run dev` — be-01 and
gw-01 under `bun --watch`, fe-01 under Vite. **For application code the watchers are the
deploy**; nothing is built, pushed or restarted.

Verified 2026-08-04: a pushed change appeared on dev with the container's `StartedAt`
unchanged to the nanosecond.

**Not every change can reach a running process that way.** This is the constraint the
design trades for its speed, not a feature — know which column your change is in:

| Change                                                          | What carries it                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App source under `apps/*/src`                                   | The watchers. Nothing restarts.                                                                                                                                                                                                                                             |
| `bun.lock`                                                      | `tool-devsync` restarts and runs `bun install`.                                                                                                                                                                                                                             |
| A migration under `apps/be-01/drizzle`                          | `tool-devsync` restarts; be-01 migrates at boot (`MIGRATE_ON_STARTUP=true`). Migrations are imported by no watched module, so nothing else would notice one arrive.                                                                                                         |
| `package.json`, `nx.json`, any `project.json`, `vite.config.ts` | `tool-devsync` restarts. Nx and Vite read these once at startup.                                                                                                                                                                                                            |
| `libs/solver-py`, `apps/be-01/Dockerfile`                       | The target-revision deployer automatically publishes a digest-pinned `be` image, materializes and installs its host-owned solver binding, preflights it, and only then resets. The directory pathspec is recursive; missing or contradictory host inputs fail before reset. |
| `deploy/dev-src/Dockerfile`                                     | **The deploy fails and names the fix** (`RECREATE_PATHS`, since 2026-08-04). Rebuild the image on h2puni from `deploy/dev-src`, then recreate.                                                                                                                              |
| `deploy/dev-src/compose.yml`                                    | **The deploy fails and names the fix.** `cd /home/puni1/wbs-dev/src/deploy/dev-src && docker compose up -d`.                                                                                                                                                                |
| Per-tier `apps/<tier>/.env`                                     | **Nothing** — gitignored, so a push cannot carry it. Edit on h2puni and restart the container.                                                                                                                                                                              |

`tools/tool-devsync/src/sync.ts` holds both lists: `RESTART_PATHS` (a restart applies it)
and `RECREATE_PATHS` (a restart cannot — the running container was created from the old
file, so its mounts, user, limits and image are still the old ones). Until 2026-08-04 the
second case was silent, and the deploy reported success for a change that was in effect
nowhere. The env row is still silent, because a gitignored file cannot arrive in a push.

The host-owned solver supervisor service, config, and Unix socket are deploy prerequisites only
when `libs/solver-py` or `apps/be-01/Dockerfile` changed between the currently deployed and
requested commits; the directory pathspec is recursive. Unrelated changes retain the existing
preflight-then-reset path and do not publish or install anything.

For a solver-affecting target, the candidate deployer runs from a clean detached clone of that
exact revision. Under the deploy exclusion it derives the compatibility-tree identity, validates
the installed production blue and green mappings, or bootstraps a missing first config from the
exact digest-pinned images configured on the two prod containers. A present but unreadable config
never falls back. It publishes only `be` through Dagger from the target clone and accepts only the
requested full SHA and registry-returned digest in the release manifest. It then materializes a
replacement config that preserves both production mappings,
builds and executes the checked-in supervisor installer, and runs the installed bundle's dev
preflight. The live checkout reset is last.

Installing the host-wide config restarts `wbs-solver-supervisor.service`, which serves both dev
and production callers and therefore causes a brief production solver interruption. The config
move, service restart, readiness check, and mapping preflight are held under the canonical
`/home/puni1/wbs/state/deploy.lock`; if a production swap holds it, this poll refuses before host
mutation and the normal deploy-health alarm owns escalation.

Publication is checkpointed at
`/home/puni1/wbs-dev/state/solver-preparation.<compatibility-identity>.json`. A retry after an
interrupted install reuses that exact immutable digest instead of publishing again. An unrelated
successor commit with the same compatibility identity rebinds that digest to its new source SHA.
A completed retry rechecks the service, socket, config, and mapping before reset; if shared config
was replaced by another identity, it reinstalls once under the production lock. State for another
compatibility identity, a tag-only image, divergent production mappings, malformed host files, or a failed
publish/install/preflight all refuse before reset. The registry credential is read only when a
publish is required and is passed only in the publisher child's environment; neither the config
nor durable state contains it.

The commands below are recovery tools, not a prerequisite for an ordinary solver-affecting poll
tick. Use them only to reconstruct a missing host baseline or to repair a refused automatic
transition. The checked-in installer publishes the bundle, mode-0600 config, and user unit and
verifies the service and socket.

The command shape is explicit; replace the descriptive image identities and local output path
with release-manifest values, first dry-run the installer, then repeat its last command with
`--execute`:

```sh
bun run tools/tool-remote-scripts/src/materialize-solver-supervisor-config.ts \
  --blue-image=REGISTRY/BE@sha256:BLUE_DIGEST \
  --green-image=REGISTRY/BE@sha256:GREEN_DIGEST \
  --dev-solver-image=REGISTRY/BE@sha256:DEV_DIGEST \
  --dev-source-sha=FULL_DEV_SOURCE_COMMIT \
  --output=/absolute/local/path/solver-supervisor.json
bunx nx run tool-remote-scripts:build
bun run tools/tool-remote-scripts/src/install-solver-supervisor.ts \
  --config=/absolute/local/path/solver-supervisor.json --dry-run
bun run tools/tool-remote-scripts/src/install-solver-supervisor.ts \
  --config=/absolute/local/path/solver-supervisor.json --execute
```

Use a new output path by default. Add `--replace` to the materializer only when intentionally
overwriting an existing local output after rechecking every commit and digest identity; without it,
an existing output fails closed. In a manual recovery, publish the image first, materialize and
dry-run locally, then install the target config and immediately deploy its matching source commit.
Do not stage a future mapping and wait: any intervening deploy is deliberately refused until source
and mapping agree.

The config records a full `devSourceSha`; `tool-devsync` also diffs the solver compatibility
paths between that commit and the requested commit, so a changed solver package cannot silently
run under an older image.

### Durable poller recovery

The poller and its managed interpreter live outside the reset checkout. The installed helper is a
recovery copy, but a normal tick streams `bin/dev-poll-sync.sh` from the exact fetched target commit;
otherwise the first target that changes the candidate shape would run through an older loader that
cannot materialize it. Install the poller, recovery helper, and exact gate interpreter together
after their reviewed commit lands on `main`:

```sh
scp bin/dev-poll.sh h2puni:/home/puni1/wbs-dev/bin/poll.next.sh
scp bin/dev-poll-sync.sh h2puni:/home/puni1/wbs-dev/bin/dev-poll-sync.next.sh
scp .bun-version h2puni:/home/puni1/wbs-dev/bin/bun-version.next
ssh h2puni 'flock -n /home/puni1/wbs-dev/state/poll.lock sh -c \
  "bun_version=\$(cat /home/puni1/wbs-dev/bin/bun-version.next) && \
   bun_source=\$(command -v bun) && \
   test \"\$(\"\$bun_source\" --version)\" = \"\$bun_version\" && \
   install -m 0755 \"\$bun_source\" /home/puni1/wbs-dev/bin/bun.next && \
   chmod 0755 /home/puni1/wbs-dev/bin/poll.next.sh \
    /home/puni1/wbs-dev/bin/dev-poll-sync.next.sh && \
   mv /home/puni1/wbs-dev/bin/bun.next /home/puni1/wbs-dev/bin/bun && \
   mv /home/puni1/wbs-dev/bin/bun-version.next /home/puni1/wbs-dev/bin/bun-version && \
   mv /home/puni1/wbs-dev/bin/dev-poll-sync.next.sh \
    /home/puni1/wbs-dev/bin/dev-poll-sync.sh && \
   mv /home/puni1/wbs-dev/bin/poll.next.sh /home/puni1/wbs-dev/bin/poll.sh"'
```

`.bun-version` is the poller's version source of truth. On a Bun bump, update that file first,
install the matching interpreter, and rerun the whole lock-held block so the binary and installed
version file move together; changing a literal in the loader is neither necessary nor sufficient.

Puni1's existing every-minute crontab continues to run `/home/puni1/wbs-dev/bin/poll.sh`. Each tick
fetches `origin/main`, resolves that named remote ref rather than the process-global `FETCH_HEAD`,
reads the candidate loader from that exact commit with `git show`, creates a shared detached clone
at the exact target commit under `bin/`, atomically renames the
completed candidate, and runs it from that clone with the managed interpreter. Its HEAD must equal
the requested full SHA and its tracked tree must be clean. The candidate contains the complete
target build context, including Dockerfiles, publisher, supervisor installer, lockfile, `tools/`,
`libs/`, and root configs rather than `sync.ts` alone. It carries no `node_modules` at all — not the
pinned checkout's by link, not anyone's — which is the TASK-376 contract below.

The full clone matters twice: the deployer reaches the deploy contract through the `@wbs/*`
tsconfig paths, and a solver-affecting tick must give Dagger the target revision's build context.
Bun resolves path aliases from the tsconfig nearest the importing file, so a bare `sync.ts` copy in
`bin/` fails on `Cannot find module '@wbs/deploy-contract'` — every tick did when that copy was first
installed (2026-09-07). Different targets cannot overwrite one another when a manual deploy overlaps
a tick; `sync.ts`'s deploy lock still serializes host work and checkout mutation. If a target deployer
throws before reset, the checkout stays put; a later fixed target supplies and executes its own
repaired deployer on the next tick, against the contract it was written with rather than the
checkout's. The target tool still performs every solver, restart, recreate, and post-reset HEAD
check, while the outer poll lock and `/health` commit proof remain intact. Do not recover with a raw
`git reset`; that bypasses the checks whose refusal is the reason the checkout did not move.

**The candidate has no `node_modules`, and a tick that refuses with `the deployer's import graph does
not resolve inside the extracted candidate` means someone gave `sync.ts` a third-party import.**
Until 2026-09-08 the loader linked the pinned checkout's install into the candidate; that install
belongs to whatever commit the checkout last reset to, so it can never hold a package the target just
added, and it silently holds the pre-reset version of one the target just bumped. The loader now
bundles the extracted deployer through the managed Bun with no install in scope, before running it,
and refuses on any unresolvable specifier. Fix the target commit — `sync.ts`'s graph may use relative
imports, `@wbs/*` aliases and Bun/Node builtins only — or vendor the code into `tools/` or `libs/` so
the archive carries it. Do not restore the symlink: the deployer runs _before_ any install for its
own commit can exist, which is the bootstrap deadlock TASK-354 fixed.

The guard asks two questions, and the second has its own refusal, `the deployer resolves files
outside the extracted candidate`, followed by the offending path. Resolving is not the same as
staying home: an absolute path into `/home/puni1/wbs-dev/src/node_modules`, or enough `../`, resolves
perfectly well and borrows the same stale install by hand. The loader therefore builds from inside
the candidate with `--metafile` and refuses any input that is absolute or above it. `--reject-
unresolved` covers the other half — Bun's default allows an opaque `await import(name)` straight
through — at the price that every specifier in the deployer must be statically analysable, including
a computed `node:fs`. Neither question can see code assembled at run time by `eval` or
`new Function`; the contract is a contract, and this is the enforcement it admits of.

**The guard covers the process the loader starts, not the ones the deployer spawns.** A
solver-affecting tick (TASK-326) runs `tools/tool-dagger/src/main.ts` and `bun x nx run
tool-remote-scripts:build` from the candidate root, and both need an install the candidate does not
have: the publisher imports `@dagger.io/dagger` and reads its manifest at
`<root>/node_modules/@dagger.io/dagger/package.json`. Measured 2026-09-09 in a `--shared` clone with no
`node_modules`: Bun's default auto-install resolved the static import silently from its global cache,
and the manifest read then failed on `ENOENT … node_modules/@dagger.io/dagger/package.json` — before
`with-heavy-lock.sh` ran anything, so nothing was published, installed or reset. That is the
fail-closed refusal an unrelated tick never meets; a solver-affecting target cannot be deployed by the
poller until the candidate is given an install of its own (`bun install --frozen-lockfile` from its
own lockfile, after the guard and before the deployer), which is an open decision, not a symlink to
restore. The materializer, installer and supervisor bundle need no install: each bundles with
`--reject-unresolved` from the clone alone.

Dev has **no edge password**. It was removed 2026-08-06: it was a second login on top of the
app's own, and a browser that had cached a wrong credential for the realm could not be talked
out of it — which cost a real debugging session. The gated config is backed up beside
`site-dev.caddy` on h2puni if it is ever wanted again.

What still guards dev: be-01 applies the configured authentication mode to every
protected `/api` route. gw-01 accepts the fixed identity only in explicit local
mode; OIDC mode requires the `__Host-wbs_access` httpOnly cookie and the exact
configured Origin (`apps/gw-01/src/app.ts`). Query parameters never establish
WebSocket identity. **`POST /api/auth/register` is mounted in every mode**
(`apps/be-01/src/controller/auth.routes.ts`) and answers 404 unless
`AUTH_PASSWORD_REGISTER=true` — the auth mode does not gate it, and that flag is
not `AUTH_PASSWORD_LOGIN`. Where the flag is on, registration is open to the
internet, which is the trade that was made knowingly.

Per-tier env lives in gitignored `apps/<tier>/.env` inside that checkout, **not** in
compose `env_file`: compose merges every env file into one namespace, so `be-01.env` and
`gw-01.env` both setting `PORT` put both tiers on 3200.

The old image-based dev containers (`dev-*-blue`) are **stopped, not removed** — they plus
the `site-dev.caddy.bak-*` backups are the rollback. Delete them after a week of stability.

**What dev no longer proves.** The blue/green swap, health gate, Caddy repoint and smoke
test used to run on dev before prod. They no longer do. Run a prod dry-run deliberately
before any prod deploy; dev will not catch a regression in that path.
