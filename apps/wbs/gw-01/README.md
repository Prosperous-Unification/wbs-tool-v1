# gw-01

The WebSocket gateway: fan-out, resume and presence. Port 3200. It owns no data
— every write is an HTTP call to be-01, and a client message arriving over the
socket is acknowledged and carried no further.

## Where things are

- **`controller/ws.controller.ts`** — `handleWsMessage`: the whole inbound
  vocabulary (`ping`, `who`, `resume`, `subscribe`, `unsubscribe`, a forward),
  pure over a `WsSocket`.
- **`controller/internal.controller.ts`** — be-01's push, fanned out to the
  sockets on that subscription.
- **`service/presence.ts`** — who is on each project, and the roster broadcast.
- **`service/subscription-map.ts`** — sockets by subscription, both directions.
- **`service/forward-client.ts`** — the call to be-01, with the internal secret.

Every outbound frame is built by `@wbs/contracts`' `ws-frames.ts`. None of them
is a `JSON.stringify` literal any more, because two of the literals had drifted
from the parser fe-01 judges them with.

## Refusals

A frame it cannot read is answered `{ type: 'error', code: 'invalid_payload' }`
and the socket stays open. A subscription that names no project and is not
`presence` is refused by name (`unknown_subscription`) rather than registered —
otherwise a typo is a socket that receives nothing, forever, silently.
be-01 unreachable is `resume_denied` with `reason: 'unavailable'` per
subscription, then an empty `resume_ack`: the client is told, rather than left on
an open socket with stale rows and no reason to refetch.

## Landmines

- **A replay goes to the socket that asked, never to `socketsFor()`.** The other
  sockets received those events live; sending them again is a refetch each, per
  event, per reconnecting peer.
- **`resume_ack` is sent last**, counted from the frames actually written. An
  acknowledgement that arrived first would let a client advance its sequence past
  frames it has not been handed.
- The `INTERNAL_AUTH_SECRET` is the same value both tiers encode; a mismatch
  fails only the socket, which reads as a gateway bug rather than as
  configuration.

## Test

```sh
bunx nx run gw-01:test         # 59 cases, including the fan-out integration
```
