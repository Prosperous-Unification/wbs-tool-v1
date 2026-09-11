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

Pending. All automated commands run on h2puni or CI, never this box.

## Failure-proof table

Pending the red focused config test and missing-guard injection.
