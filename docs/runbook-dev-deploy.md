# Runbook — deploying dev

Dev runs from source on h2puni. One command, from h1claw:

```sh
git push && ./bin/dev-deploy.sh
```

Everything below is what that command does, and what it cannot do.

**Dev does not use any of the below.** Since 2026-08-04 dev runs from source:

```sh
git push && ./bin/dev-deploy.sh     # from h1claw, after any change
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

| Change                                                          | What carries it                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App source under `apps/*/src`                                   | The watchers. Nothing restarts.                                                                                                                                     |
| `bun.lock`                                                      | `tool-devsync` restarts and runs `bun install`.                                                                                                                     |
| A migration under `apps/be-01/drizzle`                          | `tool-devsync` restarts; be-01 migrates at boot (`MIGRATE_ON_STARTUP=true`). Migrations are imported by no watched module, so nothing else would notice one arrive. |
| `package.json`, `nx.json`, any `project.json`, `vite.config.ts` | `tool-devsync` restarts. Nx and Vite read these once at startup.                                                                                                    |
| `deploy/dev-src/Dockerfile`                                     | **The deploy fails and names the fix** (`RECREATE_PATHS`, since 2026-08-04). Rebuild the image on h2puni from `deploy/dev-src`, then recreate.                      |
| `deploy/dev-src/compose.yml`                                    | **The deploy fails and names the fix.** `cd /home/puni1/wbs-dev/src/deploy/dev-src && docker compose up -d`.                                                        |
| Per-tier `apps/<tier>/.env`                                     | **Nothing** — gitignored, so a push cannot carry it. Edit on h2puni and restart the container.                                                                      |

`tools/tool-devsync/src/sync.ts` holds both lists: `RESTART_PATHS` (a restart applies it)
and `RECREATE_PATHS` (a restart cannot — the running container was created from the old
file, so its mounts, user, limits and image are still the old ones). Until 2026-08-04 the
second case was silent, and the deploy reported success for a change that was in effect
nowhere. The env row is still silent, because a gitignored file cannot arrive in a push.

Dev has **no edge password**. It was removed 2026-08-06: it was a second login on top of the
app's own, and a browser that had cached a wrong credential for the realm could not be talked
out of it — which cost a real debugging session. The gated config is backed up beside
`site-dev.caddy` on h2puni if it is ever wanted again.

What still guards dev: be-01 applies the configured authentication mode to every
protected `/api` route. gw-01 accepts the fixed identity only in explicit local
mode; OIDC mode requires the `__Host-wbs_access` httpOnly cookie and the exact
configured Origin (`apps/gw-01/src/app.ts`). Query parameters never establish
WebSocket identity. **`POST /api/auth/register` is mounted in every mode**
(`apps/be-01/src/controller/auth.controller.ts`) and answers 404 unless
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
