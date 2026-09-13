# realtime

The browser half of the socket, as scaffold. `runtime:browser`.

## Read this first

**The live client is not here.** fe-01's `src/lib/project-stream.ts` is what the
plan page runs: it subscribes, resumes, backs off, and refetches on any frame.
This library is the generic client the tool was built to grow into — a
heartbeat, a `SubscriptionTracker` in storage, an attempt ceiling — and nothing
imports it today.

That is deliberate (the infra is the deliverable), and it comes with one duty:
**the two must not disagree**. They did until 2026-09-02, when this one advanced
a subscription's sequence **on the frame** while the live one documents at length
why it must not — a refetch may fail, the table keeps the last good tree on
purpose, and a stream that advanced on the frame would resume past an edit
nobody ever saw. It takes a `seen(subscription, seq)` from its caller now.

## Two files

- **`reconnecting-ws.ts`** — `createReconnectingWs`: backoff with jitter, a
  ping/pong heartbeat, `resume` on open, and the state machine
  (`open` → `reconnecting` → `denied` → `closed`).
- **`subscription-tracker.ts`** — where each subscription has been read up to,
  in `localStorage`.

Every frame either of them sends comes from `@wbs/contracts`, so gw-01 cannot be
handed a field name only one client knows.

## Test

```sh
bunx nx run realtime:test      # 8 cases, including a monotonicity property
```
