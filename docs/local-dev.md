# Local Development

Quick reference for running `be-01`, `gw-01`, `fe-01` on your workstation — no
Docker, no Hetzner box, no deploy pipeline.

## One-time setup

```bash
bun install
bun run dev:setup        # copies apps/*/.env.example → apps/*/.env (non-destructive)
```

That seeds three local env files with safe dev-only defaults. It never overwrites
an existing `.env`, and it **fails** rather than skipping if a committed
`.env.example` is missing — that means the checkout is incomplete, and seeding
around it only moves the failure to an unexplained crash at serve time.

| File              | Purpose                                              |
| ----------------- | ---------------------------------------------------- |
| `apps/be-01/.env` | backend config: `PORT`, `DB_PATH`, `INTERNAL_AUTH_*` |
| `apps/gw-01/.env` | gateway config: ports, `BE_URL`, JWT signing keys    |
| `apps/fe-01/.env` | Vite `VITE_*` vars pointing at local be-01 + gw-01   |

All three are gitignored. Edit them freely.

## Run all three at once

```bash
bun run dev
```

That runs `nx run-many -t serve --projects=be-01,gw-01,fe-01 --parallel=3` which
brings up:

| App     | URL                     | Notes                                |
| ------- | ----------------------- | ------------------------------------ |
| `be-01` | <http://localhost:3100> | Bun + Elysia; SQLite at `./local.db` |
| `gw-01` | <http://localhost:3200> | Bun + Elysia; WS on `/ws`            |
| `fe-01` | <http://localhost:4200> | Vite dev server with HMR             |

Logs are interleaved. `Ctrl-C` stops all three.

## Run one at a time

```bash
bun run dev:be           # just the backend
bun run dev:gw           # just the gateway
bun run dev:fe           # just the frontend
```

Equivalent to `nx run be-01:serve` etc. Each one runs under `bun --watch` (or
Vite's own watcher for fe-01) so source edits reload automatically.

## Sanity checks

Once `bun run dev` is up:

```bash
curl http://localhost:3100/health
curl http://localhost:3100/metrics | head
curl http://localhost:3200/health
curl http://localhost:3200/metrics/snapshot
curl http://localhost:3200/metrics | head
open http://localhost:4200/
```

Expected:

- `/health` returns `{"status":"ok"}` on both backends.
- `/metrics` returns Prometheus text format (OTel exporter + `target_info`; app
  counters appear once any traffic flows).
- `/metrics/snapshot` on gw-01 returns the in-memory counters JSON (useful for
  manual inspection without scraping).

## Tests / lint / typecheck

```bash
bunx nx run-many -t test lint typecheck build   # the gate — what CI runs
bunx nx format:check --all                      # also what CI runs
bun run format                                  # prettier --write
```

Use the Nx gate, not root `bun test`. Root `bun test` runs **0** of `fe-01`'s
test files — they are Vitest + jsdom and `bun:test` does not discover them, so
it reports a clean run having never looked at the frontend. Measured: root
`bun test` = 357 tests / 50 files with nothing from `apps/fe-01`;
`bunx nx test fe-01` = 5 tests / 2 files.

`build` needs `shellcheck` on PATH (`brew install shellcheck`) and is no longer
allowed to skip itself when it is absent.

Scoped variants:

```bash
bunx nx test be-01
bunx nx test gw-01
bunx nx test fe-01           # vitest + jsdom
bunx nx test validation      # or domain, contracts, realtime, config, ...
```

## Observability stack (optional, local)

The full Prometheus + Grafana + Loki + Promtail stack lives in
`tools/tool-observability-stack/` and is designed for the deployed Compose
target. You can run it locally once Docker is installed:

```bash
docker compose -f tools/tool-observability-stack/src/docker-compose.yml up -d
```

Grafana: <http://localhost:3000> (admin/admin default). Prometheus scrape
config already points at `host.docker.internal:3100` and `:3200`, so it picks
up the locally-running apps. This is a convenience only — the scaffold does not
require it for day-to-day dev.

## Troubleshooting

- **"Failed to run the query" on be-01 startup** — stale `apps/be-01/local.db`
  from a partial migration. Delete it: `rm apps/be-01/local.db` and restart.
- **Port already in use** — edit `PORT=` in the relevant `apps/*/.env`. All
  URLs in peer `.env` files update by convention, not by magic; change both
  ends.
- **`@/` imports fail in fe-01 tests** — run them via `bunx nx test fe-01`
  (Vitest resolves the alias); root `bun test` does not.
- **gw-01 refuses the WS upgrade** — check the configured authentication mode.
  The seeded local mode uses its fixed development identity, so
  `wscat -c 'ws://localhost:3200/ws'` opens without a credential. OIDC mode
  accepts only the `__Host-wbs_access` httpOnly cookie from the configured exact
  Origin; use the browser login flow for that check. Never append `?token=` or
  `?localIdentity=`: URL values do not authenticate a socket.

## What local dev does NOT do

- No SOPS decryption — `tool-secrets` is not in the local dev loop.
- No deploy — `tool-deploy` and `tool-bootstrap` default to dry-run and are
  unwired for safety.
- No remote observability — run the Compose stack above if you want Grafana.
- No e2e / smoke checks — those are post-deploy (`tool-smoke`).
