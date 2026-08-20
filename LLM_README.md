# LLM_README

Agent orientation. Read this, then only the one doc your task needs.

**wbs-tool-v1** — collaborative real-time WBS tool. `be-01` (API, Elysia+Drizzle+bun:sqlite, :3100),
`gw-01` (WS gateway, :3200), `fe-01` (Vite+React, :80 in the image, :4200 under `vite dev`),
`mcp-01` (MCP server over be-01, stdio, spawned by its client). Nx monorepo, Bun — never npm.

Three facts explain most decisions:

- **The infra is the deliverable**, beyond what one host needs. Two reviews called it
  over-engineered; considered and rejected. Don't re-argue it.
- **The product is a working WBS editor, all of it on `main` since 2026-08-06.** Accounts and
  presence, projects, a nested table you type into and drag rows around, arrow keys between
  cells, derived numbers with a freeze, three-point estimates by role that roll up, a branch you
  duplicate whole, live edits, a Cmd+Z that **refuses out loud** when a row has moved, and a
  socket that reconnects and replays. Tables: `user`, `project`, `role`, `work_item`,
  `estimate`, `command_journal`, `event_log`, `event_sequencer`.
- Tool choices bias novel over mainstream (Bun, Elysia, ArkType, Dagger) on purpose.

## Commands

```sh
bun install                                     # first, on a fresh clone
bun run dev:setup                               # writes the .env files dev needs
bunx nx format:check --all                      # the gate, part 1
bunx nx run-many -t test lint typecheck build   # the gate, part 2
bun run dev                                     # be + gw + fe locally
bun run e2e                                     # the browser layout gate (needs chromium)
```

`bun test` at the repo root is **not** the gate: it collects fe-01's files, which fail on the
DOM `bun:test` has no jsdom for. Use `bunx nx run-many -t test`. `build` needs `shellcheck`.

**Rules: `AGENTS.md`** (symlinked to CLAUDE.md/GEMINI.md) — read it, it governs every change.

`.github/workflows/ci.yml` runs the gate above plus the secrets scan, migration lint and
`openspec validate` on every push and PR; job `pixels` runs `bun run e2e`, one chromium
measuring the WBS table against the real stack. lefthook runs a subset pre-commit and
`--no-verify` skips it; CI is not. Format uses `--all`: the base-ref default checks nothing.

## Deploy

Live: **https://wbs.bulletpoints.club** (prod = `ssh h2puni`). **Build box = h2puni.**

**Never build on h1claw.** Dany's standing rule, 2026-08-04, superseding the earlier "prefer
h1claw, it is amd64" — h1claw is a 3.7 GB VPS that runs the OpenClaw gateway and holds the
prod SSH key, registry credentials and the `ghp_` PAT. A `PreToolUse` guard there
(`~/.openclaw/workspace/bin/block-local-builds.sh`) denies `dagger`, `tool-dagger:*`,
`tool-deploy:deploy` and `docker build` outright; commands delegated over `ssh … h2puni` pass.

### dev — source-run, no build

**Dev does not use any of the prod machinery below.** Since 2026-08-04:

```sh
git push && ./bin/dev-deploy.sh     # from h1claw, seconds
```

One container, `wbs-dev-src`, runs all three tiers from a bind-mounted checkout via
`bun run dev`. **For application code the watchers are the deploy** — nothing is built, pushed
or restarted. The lockfile, migrations, and config read once at startup trigger a restart; a
changed `compose.yml` or `Dockerfile` fails the deploy with the command that applies it. Dev
has **no edge password** since 2026-08-06 — be-01 and gw-01 guard themselves, and account
registration is open to the internet.

**Which changes reach a running process, and which do not: `docs/runbook-dev-deploy.md`.**

**What dev no longer proves.** The blue/green swap, health gate, Caddy repoint and smoke test
used to run on dev before prod; they no longer do. Run a prod dry-run before any prod deploy.

### prod — image-based, blue/green

**h2puni can build and publish** since 2026-08-05: pinned `dagger` v0.21.8, a build checkout at
`/home/puni1/wbs-build` (**not** dev's), and the `h2puni` alias resolving to itself. Proven:
images published, dry run planned the swap. Runbook has the why.

Dagger builds `linux/amd64` → self-hosted registry (the only build/deploy contract) → the swap
starts the idle colour, health-gates it, repoints Caddy, drains WS, stops the old colour, runs
smoke. `--dry-run` is the default, refusing on a dirty tree, a stale `release.json` or an
unbuilt executor bundle — safety gates, not bugs.

A migration is applied by be-01's swap and by nothing else. It must be additive, must ship
a `down.sql`, and an aborted deploy reverses it (`AGENTS.md`, "Migrations").

**Commands, the PATH trap on h2puni, the Mac tunnel, and the swap's one-tier-list-per-run
contract: `docs/runbook-prod-deploy.md`.**

## Landmines

- **`columns` in `wbs-table.tsx` depends on `roles` alone**, and `roles` is replaced only when its
  content differs. Anything else remounts every cell and eats the focus; see the `live` ref. Widths resolve through `table-frame.ts`'s `frameLayout` and never enter a column definition.
- **Row tints in `styles.css` go by predicate, not source order.** A new `data-*-lit` must join the
  banded-hover rule's `:not()` chain and never land on a row the pointer already hovers, or the rule
  is unmatchable and the stripe stops tinting. Negative must hover that row (`linked-row-hover`).
- `caddy reload` **exits 0 when it did nothing**. Verify against the admin API, never the exit
  code. The check parses the route for this environment's host and reads the upstream on the
  tier's port (`routedColorFromAdminConfig`); a substring test until 2026-08-04, which matched
  `be-01-blue` inside dev's `dev-be-01-blue` and read prod's colour wrong.
- `be-01.internal` resolves to **both colours** mid-swap (round-robin). Two releases, one DB file.
- `bun:sqlite` defaults to no WAL, `busy_timeout=0`. Set **and asserted at open** in
  `be-01/src/repository/db.ts`; an ESLint rule bans importing `bun:sqlite` anywhere else under
  `apps/be-01/src`, because `busy_timeout`/`foreign_keys` are per-connection and a direct
  `new Database()` silently loses them. `boot.ts` opens through `openConnection` in that same
  file for the same reason, and closes through the handle it returns — reaching into drizzle's
  `$client` is the same bypass one layer along.
- **Migrations must be backward-compatible** — blue and green share one DB. `--stop-the-world` refuses.
  The pre-commit lint catches the obvious destructive statements; the actual compatibility judgement
  is yours, asserted by passing `--with-migrations`.
- **`bun run e2e` reuses whatever holds 3100/3200/4200** (`reuseExistingServer: !isCi`) — 66 tests
  green against another checkout, 2026-08-09, and a reused server keeps its own `DB_PATH`, so
  signups land in your `local.db`. Run `CI=1 bunx playwright test --config …` with the ports free.
- `.dockerignore` is **not recursive**: `**/*.db`, not `*.db`.
- Server umask is `0002` — give sensitive files their mode at birth, never chmod after
  (`configure.sh` does not yet honour this; see findings).
- `--platform linux/amd64` is pinned **on the Dagger publish path**, which is the only supported one.
  A hand-run `docker build` from the Dockerfiles is not pinned. Dev is arm64, server is amd64.

## Open findings

Both open findings are **prod-phase** (Dany, 2026-08-06): recorded, not pending. Work stops at dev.

1. Rollback unimplemented. `--version` is _refused_ rather than ignored, so deploying an older
   commit means checking it out and rebuilding.
2. `configure.sh`'s root phase never run on a fresh host; only the plan is tested.

Findings 3–5 closed 2026-08-06; detail pruned for the cap. Lower priority: fe/smoke health accepts any non-empty body; the WS ping passes on any first
message _containing_ `"pong"`; drain reads a malformed metrics body as zero live sockets;
`tool-secrets` only prints what it would run. Checks that cannot fail: **eighteen**, tallied in
`AGENTS.md` under R5.

## More

| Doc                                                                     | When                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/superpowers/plans/2026-08-02-compose-blue-green-HANDOVER.md`      | before touching deploy                                                                |
| `docs/superpowers/specs/2026-08-02-compose-blue-green-deploy-design.md` | why the pipeline is shaped this way                                                   |
| `docs/runbook-dev-deploy.md`                                            | deploying dev; what a deploy cannot carry                                             |
| `docs/runbook-prod-deploy.md`                                           | deploying prod; commands and their refusals                                           |
| `docs/runbook-dagger-engine-registry-dns.md`                            | engine can't resolve `registry`                                                       |
| `docs/local-dev.md`                                                     | running locally                                                                       |
| `docs/capacity.md`                                                      | why a plan's dates moved; where a team's number is typed                              |
| `apps/be-01/openapi.json`                                               | the API's own document — `bun apps/be-01/src/openapi/emit-openapi-cli.ts` rewrites it |
| `apps/mcp-01/README.md`                                                 | the MCP server: 43 tools derived from that document, stdio, client config stanza      |
| `HUMAN_README.md`                                                       | operating prod; triage runbook; openclaw path                                         |
| `openspec/changes/scaffold-tech-setup/`                                 | original scaffold — **stale**, spec above wins                                        |

Conventions: pure planners + thin IO shell; `strictTypeChecked`; comments say **why** and state
what was/wasn't verified; never print a secret value. Explicit return types are house style,
**not** lint-enforced — plenty of existing code infers them.
