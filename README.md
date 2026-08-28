# wbs-tool-v1

Collaborative real-time WBS tool. Nx monorepo, Bun everywhere — never npm.

| App     | What                                  | Port                      |
| ------- | ------------------------------------- | ------------------------- |
| `be-01` | API — Elysia + Drizzle + `bun:sqlite` | 3100                      |
| `gw-01` | WebSocket gateway                     | 3200                      |
| `fe-01` | Vite + React static frontend          | 4200 dev, 80 in the image |

Live: <https://wbs.bulletpoints.club>

## Start here

```sh
bun install
bun run dev:setup    # writes the .env files dev needs; fails if the checkout is incomplete
bun run dev          # be + gw + fe
```

Then <http://localhost:4200>. Full detail, including troubleshooting and the
observability stack: **[docs/local-dev.md](./docs/local-dev.md)**.

## Before you push

```sh
bin/h2puni-gate.sh
```

The h2puni wrapper runs the same format and Nx commands as CI while holding the
canonical heavy-work lock. CI also runs a secrets scan, migration lint and
`openspec validate`, on every push and PR. `build` needs `shellcheck`
(`brew install shellcheck`).

Root `bun test` is **not** the suite — it runs none of `fe-01`'s tests and
still reports success. Use the Nx gate.

## Working on this repo

Most of the work here is done by AI agents, and the rules that govern it are
machine-facing:

| File                                     | Read it when                                         |
| ---------------------------------------- | ---------------------------------------------------- |
| **[HUMAN_README.md](./HUMAN_README.md)** | operating this: deploying, prod triage, from a phone |
| **[AGENTS.md](./AGENTS.md)**             | always — five rules that govern every change         |
| [LLM_README.md](./LLM_README.md)         | orienting in the codebase: landmines, open findings  |
| [docs/local-dev.md](./docs/local-dev.md) | running things locally                               |
| `openspec/`                              | proposing a change (intent → specs → tasks → verify) |

`AGENTS.md` is the real file; `CLAUDE.md` and `GEMINI.md` are symlinks to it so
every agent CLI loads the same rules.

Changes to observable behavior, contracts, migrations, deploy safety or
architecture go through OpenSpec — start with `/opsx:new`. Docs and mechanical
refactors do not.
