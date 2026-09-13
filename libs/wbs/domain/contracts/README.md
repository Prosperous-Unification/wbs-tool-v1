# contracts

The shapes two tiers have to agree about, and the one place each is written.
`runtime:isomorphic`: be-01 and gw-01 parse with it, fe-01 builds with it.

## Four files

- **`ws.ts`** — the realtime vocabulary as **parsers**: `WsFrame` (a
  subscription's payload) and `WsControlFrame` (the nine control arms). What an
  inbound frame is judged against.
- **`ws-frames.ts`** — the same vocabulary as **builders**, which serialise. It
  imports nothing, so fe-01 takes it as `@wbs/contracts/ws-frames` without
  pulling arktype into the browser bundle.
- **`internal.ts`** — the be-01 ↔ gw-01 forward and push envelopes.
- **`errors.ts`** — the refusal codes both tiers name.

## Refusals

A frame that does not parse is a **modeled** refusal, never a throw at the
socket: gw-01 answers `{ type: 'error', code: 'invalid_payload' }` and keeps the
connection. A control arm this build does not know reaches the client's
`onControl` untouched rather than failing the read — a gateway and a browser are
deployed separately and one of them is always newer.

## Landmines

- **A builder and its parser must round-trip.** They did not, twice: gw-01 sent
  `resume_denied` with `reason: 'unavailable'` against a parser that declared
  only `'out_of_range'`, and an `error` naming a `subscription` the parser had no
  field for. Neither showed as a failure, because fe-01 reads `type` and ignores
  the rest. `the frames a builder writes` is the assertion that closed it.
- **Field order is the builders'**, because a caller comparing sent strings
  compares them byte for byte.

## Test

```sh
bunx nx run contracts:test     # 12 cases, half of them the round trip
```
