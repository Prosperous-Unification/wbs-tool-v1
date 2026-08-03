## Design Summary

Compose the existing Layer-A services (`EventSequencer`, `DrizzleEventLogRepo`, `ReplayBuffer`, `PushClient`, `runRetention`) into `apps/be-01`'s runtime so `buildApp()` exposes real behavior in place of the stubs at `apps/be-01/src/app.ts:24–34`. Replace the stub `onForward` with a pure ack (validate envelope + return `{ack:true, push_responses:[]}` — no recording). Replace the stub `onResume` with a real replay orchestrator that reads from `ReplayBuffer` first, falls back to `DrizzleEventLogRepo.rangeSince`, pushes replayed events back through gw via `PushClient` synchronously, then returns the per-subscription `{status, count}` map. Introduce a small `EventBus.broadcast(subscription, message)` helper that does the future producer-side coordination (DB record → buffer record → gw push) so the next change's tick service has a single dependency to call. Wire a 60s retention loop. No new producers — the runtime exposes the right seams; the next change wires a tick producer to actually exercise them.

## Alternatives Considered

### Approach A: Pure-wiring + EventBus seam (chosen)

- **What it is**: Replace stub callbacks with real implementations using existing services. `onForward` is a pure ack; `onResume` runs the real replay path. Add a `ReplayOrchestrator` that owns resume logic and an `EventBus` that owns producer coordination but is not invoked from anywhere in this change. Wire a retention timer.
- **Pros**:
  - Smallest change that closes inconsistency A.
  - No behavior change on the `forward` path — preserves "no product features yet" promise from `scaffold-tech-setup`.
  - `EventBus` seam is in place so the next change adds tick with one dependency wire-up + a `setInterval`, no new BE coordination code.
  - Replay is exercised via integration tests that seed `event_log` via the repo directly — no need to wait for a real producer.
- **Cons**:
  - The `ReplayBuffer` is populated only when `EventBus.broadcast` runs, and `broadcast` has zero callers in this change, so the buffer is dead at runtime here. Only DB replay is exercised in the runtime path. Acceptable: tests cover both paths; runtime parity arrives next change.
- **Why chosen**: Matches the user's choice (option C in prior turn) — split runtime wiring from diagnostics. Keeps each change one-purpose.

### Approach B: Wiring + echo-on-forward

- **What it is**: Same as A, but `onForward` calls `EventBus.broadcast(msg.subscription, msg.message)` so every forwarded message is recorded and fanned out.
- **Pros**: Exercises the producer→push path in this change without waiting for the tick service. Buffer is populated at runtime.
- **Cons**: Echo-on-forward is product-shape (which messages get echoed? all of them? are typing-indicators echoed? are subscribe frames echoed?). Encoding a default rule here forces a product decision inside a wiring change. The next change's tick is the cleaner producer; once it lands, the echo behavior would either be removed or kept as legacy.
- **Why not chosen**: Conflates two changes; bleeds product design into wiring; the tick smoke is one change away.

### Approach C: Wiring + dedicated tick producer

- **What it is**: Include a `TickService` with a 1-Hz `setInterval` that broadcasts to subscription `"tick"`, alongside the wiring.
- **Pros**: Single change with a complete, observable proof of the runtime path.
- **Cons**: Violates the user's chosen split (option C in the prior turn — runtime wiring is its own change so diagnostics rides on top). Tick is a _diagnostic producer_, conceptually owned by the next change.
- **Why not chosen**: Re-merges scope the user just asked to keep separate.

## Agreed Approach

**A**. Pure-wiring + `EventBus` seam in place but uncalled. `onForward` is a pure ack. `onResume` does real replay through buffer→DB fallback, sequential synchronous push, then the count map. Retention loop runs every 60s.

## Key Decisions

1. **`onForward` is a pure ack.** Validates the `InternalForwardRequest` envelope, returns `{ack: true, push_responses: []}`. No `recordEvent` call, no `push`. Deferred to a later product change.
2. **`onResume` is synchronous: replay pushes complete BEFORE `resume_ack` returns.** The contract surface returns `{[sub]: {status, count}}`; the actual events arrive at the client via the same socket via the normal push path. Sending `resume_ack` _before_ the events arrive would let the client think it's caught up and re-render before the events land — confusing optimistic UIs. Sequence: for each subscription, push events in seq order; collect counts; return the map.
3. **Replay reads from `ReplayBuffer` first, falls back to `DrizzleEventLogRepo.rangeSince`.** If `buffer.since(sub, since)` returns at least one entry AND `buffer.oldestSeq(sub) <= since + 1`, use buffer (in-memory hit, fast). Otherwise call `repo.rangeSince(sub, since)` (durable fallback, slower). If `repo.oldestSeq(sub)` is itself `> since`, return `{status: 'denied', reason: 'out_of_range'}`.
4. **Push failures during replay are logged but do NOT fail the resume call.** A `PushFailed` thrown by `PushClient` for one event is caught, logged at `warn`, and replay continues for remaining events. The client will reconnect with a new `last_seq` and resume again — protocol is idempotent. Failing the entire resume call would make a single dropped push poison the whole reconnect; that's worse.
5. **`EventBus.broadcast(subscription, message)` is the _only_ sanctioned producer entrypoint.** It does: `recordEvent` → `replayBuffer.record` → `pushClient.push`. No callers in this change; the next change's tick service is the first caller. Keeping it here so the producer flow is owned by _this_ change's wiring; the next change just wires `setInterval(() => bus.broadcast("tick", {ts: Date.now()}), 1000)`.
6. **Retention loop runs every 60s** in-process, calling `runRetention(repo, {maxPerSubscription: 10_000})`. Owned by a `RetentionTimer` with `start()` / `stop()`. Started after migrations apply, stopped on SIGTERM.
7. **Database lifecycle moves into `main.ts`**, with an in-memory or file-path DB resolved from `DB_PATH`. The `Database` instance is passed into `buildApp` via the new `services` dependency object so tests can substitute `:memory:` or stubs without touching `main.ts`.
8. **`buildApp(opts)` signature changes**: `opts.services: { eventBus, replayOrchestrator, retentionTimer }` replaces the inlined stub callbacks. `onForward` and `onResume` become internal implementations of `internalController` that call into `services`. Tests instantiate fakes for those services.
9. **`PushClient` configuration — `maxRetries=5`, exponential 500ms→30s** matches the existing default. No config surface added in this change.
10. **No changes to gw-01, libs/contracts, libs/realtime, or any frontend.** Pure BE wiring.

## Open Questions

All four pre-existing questions resolved in Key Decisions:

- (Q1) sync push vs durable outbox → moot for this change; only push site is replay (1 burst per resume), synchronous (Decision 2).
- (Q2) sequencer concurrency → already correct in existing code (single bun:sqlite transaction with `INSERT ON CONFLICT` + `UPDATE … RETURNING`); nothing to design.
- (Q3) what `forward` does → pure ack (Decision 1).
- (Q4) `PushClient` post-retry-exhaustion → caller decides; in this change, the only caller is replay, which catches and logs (Decision 4); future producers (tick, domain mutations) will choose per their durability needs — `event_log` is the universal recovery story.

Genuinely open, deferred to design / plan:

- **Retention period vs. retention count**: `runRetention` prunes by row count per subscription (10k cap). Should we _also_ prune by age (e.g., older than 7 days)? The `created_at` column exists. Probably yes for ergonomics, but not strictly needed — count cap is sufficient as a safety bound. Will pick in design.md (lean: count-only for now; add age in a later change if event_log size becomes a real concern).
- **Where does the `Database` connection live during tests?** Each `buildApp(opts)` test currently constructs its own minimal Elysia app. With services now coming from outside, tests need a "test fixture" that opens a `:memory:` DB, runs migrations, and constructs all five services. This belongs in `apps/be-01/src/__tests__/fixtures.ts` (or via the existing `@wbs/validation/fixtures`). Will land in the tasks artifact.
- **Should the `EventBus` API also expose `broadcastBatch(events)`?** Probably yes for the future "domain mutation that fans out 50 derived events" case, but YAGNI for now. Add when first batched producer needs it.
