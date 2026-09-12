## Why

Browser Use Cloud closes the public dev page's `vite-hmr` WebSocket after roughly ten seconds.
Vite reconnects with a `vite-ping` socket and reloads the document, so a browser assertion can
read the bare root between mount cycles and pass against no interface at all.

## What Changes

- The public source-run frontend keeps Vite's on-demand source serving but does not expose HMR.
- Local development and isolated browser gates keep HMR.
- Browser stability evidence uses one uninterrupted evaluation so a reload fails rather than
  being caught and converted into an empty sample.

## Non-Goals

Changing prod, replacing source-run dev with a production build, or hiding application faults.

## Constraints

An ordinary source change must still be served after the poller advances the checkout. No local
build or test is permitted; all automated verification runs on h2puni or CI.

## Capabilities

- `deployment-pipeline`

## Domain Terms

None.

## Decisions Recorded

None. The existing source-run dev decision remains; this changes only its public live-update mode.

## Impact

`apps/fe-01/vite.config.ts`, its config test, `deploy/dev-src/compose.yml`, and the dev runbook.
