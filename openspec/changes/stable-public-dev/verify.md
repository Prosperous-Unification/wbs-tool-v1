# Verify — stable-public-dev

## Before-side live evidence

- 2026-09-11 Browser Use Cloud: a single 40-second `page.evaluate` against public dev failed after
  13 seconds with `Execution context was destroyed, most likely because of a navigation`.
- h2puni Caddy access log for the original 2026-09-10 incident shows `vite-hmr` WebSockets lasting
  10.37–10.91 seconds, followed by `vite-ping` and a new `GET /` every 12–14 seconds. The page made
  no failed requests and logged no application error.
- A host Chrome control held the signed-out page for 50 seconds with body text/html fixed at
  `86/3190`; the failure is specific to the cloud browser's long-lived WebSocket path.

## Commands

| Exact head | Command | Result |
| --- | --- | --- |
| `f11a5a04` | focused `vite-config.test.ts` on h2puni | red as intended: 1 failed, 15 passed; public HMR was `undefined` |
| `e84f315d` | focused `vite-config.test.ts` on h2puni | 16 passed |
| `e84f315d` | `docker compose -f deploy/dev-src/compose.yml config -q` on h2puni | green |
| `e84f315d` | `bunx @fission-ai/openspec validate stable-public-dev --json` on h2puni | 1 passed, 0 failed |
| `c29ec89c` | focused `vite-config.test.ts` on h2puni | 17 passed |

Both exact-head runs used a fresh h2puni dependency tree whose 78 root declarations resolved with
`BAD_COUNT=0`. No build or autotest ran on h1claw.

## Failure-proof table

| Check | Injected fault | Observed failure |
| --- | --- | --- |
| Public mode disables HMR | production `hmr` assignment absent at `f11a5a04` | expected `false`, received `undefined` |
| Deploy process selects public mode | reverse-applied the compose wiring at `c29ec89c` | 1 failed, 16 passed; compose lacked `WBS_PUBLIC_DEV: 'true'` |
