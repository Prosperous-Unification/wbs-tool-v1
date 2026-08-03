# Wire BE-01 Runtime Layer-A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stub `onForward`/`onResume` callbacks in `apps/be-01/src/app.ts` with real Layer-A composition (`EventBus`, `ReplayOrchestrator`, `RetentionTimer`, BE metrics) so resume actually replays events and the BE acquires the producer entrypoint that the next change's tick service will use.

**Architecture:** Three new BE services (`EventBus.broadcast`, `ReplayOrchestrator.replay`, `RetentionTimer`) compose the existing `EventSequencer`, `DrizzleEventLogRepo`, `ReplayBuffer`, `PushClient`, and `runRetention`. `buildApp` accepts a `BeServices` bundle so tests can substitute fakes; `main.ts` wires real implementations against `:file` SQLite + a `PushClient` pointed at `cfg.GW_URL`. `onForward` becomes a pure ack; `onResume` delegates to `ReplayOrchestrator` whose algorithm is buffer-first-then-DB-fallback with synchronous in-order push and partial-failure tolerance.

**Tech Stack:** Bun runtime, ElysiaJS, `bun:test` (+ `@wbs/validation/fixtures`), Drizzle ORM with `bun:sqlite`, ArkType validation via `@wbs/contracts`, OTel metrics via `@wbs/observability`, structured pino logs.

---

## File Structure

**New files:**

- `apps/be-01/src/service/event-bus.ts` — `EventBus.broadcast(subscription, message): Promise<RecordedEvent>`
- `apps/be-01/src/service/event-bus.test.ts`
- `apps/be-01/src/service/replay-orchestrator.ts` — `ReplayOrchestrator.replay(points, ctx): Promise<Record<sub, ResumeResult>>`
- `apps/be-01/src/service/replay-orchestrator.test.ts`
- `apps/be-01/src/service/retention-timer.ts` — `RetentionTimer.start() / stop()`
- `apps/be-01/src/service/retention-timer.test.ts`
- `apps/be-01/src/service/be-metrics.ts` — typed wrapper over `@wbs/observability` counters/gauge
- `apps/be-01/src/service/be-metrics.test.ts`
- `apps/be-01/src/__tests__/build-services.ts` — `buildTestServices(overrides?): BeServicesTestBundle`
- `apps/be-01/src/controller/forward-pure-ack.integration.test.ts`
- `apps/be-01/src/__tests__/resume-vs-gw.integration.test.ts`
- `apps/be-01/src/__tests__/metrics.integration.test.ts`

**Modified files:**

- `apps/be-01/src/app.ts:1-43` — `AppOptions` gains `services: BeServices`; stub `onForward`/`onResume` replaced with closures sourced from `services`.
- `apps/be-01/src/main.ts:1-28` — full runtime composition + SIGTERM handler.
- `apps/be-01/src/health.test.ts:1-19` — supply `services` from `buildTestServices()`.
- `apps/be-01/src/migrate.test.ts` — supply `services`.
- `apps/be-01/src/controller/internal.integration.test.ts:1-77` — replace stub-based resume test with real-orchestrator-based one.

**Untouched:** `apps/be-01/src/repository/*`, `apps/be-01/src/service/{event-sequencer,push-client,replay-buffer,retention-job}.ts`, `apps/be-01/src/controller/internal.controller.ts`, `apps/be-01/src/middleware/*`, `apps/be-01/src/config.ts`, all of `gw-01`, all of `fe-01`, all `libs/*`.

**Test command:** From `apps/be-01/`:

- Single file: `bun test src/service/event-bus.test.ts`
- All tests: `bun test`
- Via Nx: `bunx nx test be-01`
- Typecheck: `bunx nx typecheck be-01`
- Lint: `bunx nx lint be-01`

---

## Task 1: Test fixture + service skeletons + metrics shim

**Files:**

- Create: `apps/be-01/src/service/be-metrics.ts`
- Create: `apps/be-01/src/service/be-metrics.test.ts`
- Create: `apps/be-01/src/service/event-bus.ts` (skeleton)
- Create: `apps/be-01/src/service/replay-orchestrator.ts` (skeleton)
- Create: `apps/be-01/src/service/retention-timer.ts` (skeleton)
- Create: `apps/be-01/src/__tests__/build-services.ts`

This task establishes the types and a fake-metrics path so subsequent tasks can write tests cleanly. The metrics shim is a typed interface here; the real OTel-backed implementation lands in Task 7.

- [ ] **Step 1.1: RED — write failing test for `BeMetrics` shape**

Create `apps/be-01/src/service/be-metrics.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createFakeBeMetrics } from '../__tests__/build-services';

describe('BeMetrics interface', () => {
  it('records broadcast deliveries and failures', () => {
    const m = createFakeBeMetrics();
    m.broadcastDelivered(3);
    m.broadcastDelivered(2);
    m.broadcastPushFailed();
    expect(m.snapshot.broadcastDelivered).toBe(5);
    expect(m.snapshot.broadcastPushFailed).toBe(1);
  });

  it('records resume replays by result', () => {
    const m = createFakeBeMetrics();
    m.resumeReplays('replaying');
    m.resumeReplays('replaying');
    m.resumeReplays('denied');
    expect(m.snapshot.resumeReplaysReplaying).toBe(2);
    expect(m.snapshot.resumeReplaysDenied).toBe(1);
  });

  it('sets event_log row gauge', () => {
    const m = createFakeBeMetrics();
    m.eventLogRows(42);
    expect(m.snapshot.eventLogRows).toBe(42);
    m.eventLogRows(40);
    expect(m.snapshot.eventLogRows).toBe(40);
  });
});
```

- [ ] **Step 1.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/service/be-metrics.test.ts`
Expected: FAIL — `createFakeBeMetrics` does not exist.

- [ ] **Step 1.3: GREEN — define `BeMetrics` interface and fake**

Create `apps/be-01/src/service/be-metrics.ts`:

```ts
export type ResumeResult = 'replaying' | 'denied';

export interface BeMetrics {
  broadcastDelivered(count: number): void;
  broadcastPushFailed(): void;
  resumeReplays(result: ResumeResult): void;
  eventLogRows(total: number): void;
}
```

Create `apps/be-01/src/__tests__/build-services.ts`:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createLogger } from '@wbs/observability';
import type { InternalPushRequest } from '@wbs/contracts';

import { DrizzleEventLogRepo } from '../repository/event-log';
import { EventSequencer } from '../service/event-sequencer';
import { ReplayBuffer } from '../service/replay-buffer';
import { PushClient } from '../service/push-client';
import { EventBus } from '../service/event-bus';
import { ReplayOrchestrator } from '../service/replay-orchestrator';
import type { BeMetrics, ResumeResult } from '../service/be-metrics';

export interface FakeBeMetrics extends BeMetrics {
  snapshot: {
    broadcastDelivered: number;
    broadcastPushFailed: number;
    resumeReplaysReplaying: number;
    resumeReplaysDenied: number;
    eventLogRows: number;
  };
}

export function createFakeBeMetrics(): FakeBeMetrics {
  const snapshot = {
    broadcastDelivered: 0,
    broadcastPushFailed: 0,
    resumeReplaysReplaying: 0,
    resumeReplaysDenied: 0,
    eventLogRows: 0,
  };
  return {
    snapshot,
    broadcastDelivered(n) {
      snapshot.broadcastDelivered += n;
    },
    broadcastPushFailed() {
      snapshot.broadcastPushFailed += 1;
    },
    resumeReplays(r: ResumeResult) {
      if (r === 'replaying') snapshot.resumeReplaysReplaying += 1;
      else snapshot.resumeReplaysDenied += 1;
    },
    eventLogRows(n) {
      snapshot.eventLogRows = n;
    },
  };
}

export interface PushCall {
  payload: InternalPushRequest;
}

export interface FakePushClient {
  push(payload: InternalPushRequest): Promise<{ delivered: number }>;
  calls: PushCall[];
  /** When set, the next N pushes resolve as `delivered`; subsequent pushes throw `PushFailed`. */
  failAfter?: number;
}

export function createFakePushClient(opts?: {
  delivered?: number;
  failAfter?: number;
}): FakePushClient {
  const calls: PushCall[] = [];
  const delivered = opts?.delivered ?? 1;
  const fakeClient: FakePushClient = {
    calls,
    failAfter: opts?.failAfter,
    async push(payload) {
      calls.push({ payload });
      if (typeof fakeClient.failAfter === 'number' && calls.length > fakeClient.failAfter) {
        const { PushFailed } = await import('../service/push-client');
        throw new PushFailed(`fake push failed: call=${String(calls.length)}`);
      }
      return { delivered };
    },
  };
  return fakeClient;
}

export interface BuildTestServicesOverrides {
  pushClient?: FakePushClient;
}

export interface TestServicesBundle {
  db: Database;
  drizzleDb: ReturnType<typeof drizzle>;
  repo: DrizzleEventLogRepo;
  buffer: ReplayBuffer;
  sequencer: EventSequencer;
  pushClient: FakePushClient;
  eventBus: EventBus;
  replayOrchestrator: ReplayOrchestrator;
  metrics: FakeBeMetrics;
  cleanup: () => void;
}

export function buildTestServices(overrides: BuildTestServicesOverrides = {}): TestServicesBundle {
  const db = new Database(':memory:');
  const drizzleDb = drizzle(db);
  migrate(drizzleDb, { migrationsFolder: 'drizzle' });
  const logger = createLogger({ service: 'be-01-test' });
  const repo = new DrizzleEventLogRepo(drizzleDb);
  const buffer = new ReplayBuffer({ maxPerSubscription: 1000, maxAgeMs: 5 * 60_000 });
  const sequencer = new EventSequencer(repo);
  const metrics = createFakeBeMetrics();
  const pushClient = overrides.pushClient ?? createFakePushClient();
  const eventBus = new EventBus({
    sequencer,
    buffer,
    pushClient: pushClient as unknown as PushClient,
    metrics,
    logger,
  });
  const replayOrchestrator = new ReplayOrchestrator({
    buffer,
    repo,
    pushClient: pushClient as unknown as PushClient,
    metrics,
    logger,
  });
  return {
    db,
    drizzleDb,
    repo,
    buffer,
    sequencer,
    pushClient,
    eventBus,
    replayOrchestrator,
    metrics,
    cleanup: () => {
      db.close();
    },
  };
}
```

Create `apps/be-01/src/service/event-bus.ts` (skeleton):

```ts
import type { Logger } from '@wbs/observability';

import type { EventSequencer, RecordedEvent } from './event-sequencer';
import type { ReplayBuffer } from './replay-buffer';
import type { PushClient } from './push-client';
import type { BeMetrics } from './be-metrics';

export interface EventBusDeps {
  sequencer: EventSequencer;
  buffer: ReplayBuffer;
  pushClient: PushClient;
  metrics: BeMetrics;
  logger: Logger;
}

export class EventBus {
  constructor(private readonly deps: EventBusDeps) {}

  async broadcast(_subscription: string, _message: unknown): Promise<RecordedEvent> {
    throw new Error('not implemented');
  }
}
```

Create `apps/be-01/src/service/replay-orchestrator.ts` (skeleton):

```ts
import type { Logger } from '@wbs/observability';

import type { EventLogRepo } from '../repository/event-log';
import type { ReplayBuffer } from './replay-buffer';
import type { PushClient } from './push-client';
import type { BeMetrics } from './be-metrics';

export interface ReplayOrchestratorDeps {
  buffer: ReplayBuffer;
  repo: EventLogRepo;
  pushClient: PushClient;
  metrics: BeMetrics;
  logger: Logger;
}

export type ResumeStatus =
  | { status: 'replaying'; count: number }
  | { status: 'denied'; reason: 'out_of_range' };

export interface ResumeContext {
  clientId: string | null;
  connectionId: string | null;
  traceId: string;
}

export class ReplayOrchestrator {
  constructor(private readonly deps: ReplayOrchestratorDeps) {}

  async replay(
    _points: Record<string, number>,
    _ctx: ResumeContext,
  ): Promise<Record<string, ResumeStatus>> {
    throw new Error('not implemented');
  }
}
```

Create `apps/be-01/src/service/retention-timer.ts` (skeleton):

```ts
import type { Logger } from '@wbs/observability';

import type { EventLogRepo } from '../repository/event-log';
import type { BeMetrics } from './be-metrics';

export interface RetentionTimerDeps {
  repo: EventLogRepo;
  metrics: BeMetrics;
  logger: Logger;
  intervalMs: number;
  maxPerSubscription: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export class RetentionTimer {
  constructor(private readonly deps: RetentionTimerDeps) {}

  start(): void {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }
}
```

- [ ] **Step 1.4: GREEN — verify metrics test passes**

Run: `cd apps/be-01 && bun test src/service/be-metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 1.5: Commit**

```bash
git add apps/be-01/src/service/be-metrics.ts apps/be-01/src/service/be-metrics.test.ts apps/be-01/src/service/event-bus.ts apps/be-01/src/service/replay-orchestrator.ts apps/be-01/src/service/retention-timer.ts apps/be-01/src/__tests__/build-services.ts
git commit -m "feat(be-01): scaffold Layer-A runtime services + test fixtures"
```

---

## Task 2: `EventBus.broadcast` implementation

**Files:**

- Modify: `apps/be-01/src/service/event-bus.ts`
- Create: `apps/be-01/src/service/event-bus.test.ts`

- [ ] **Step 2.1: RED — write failing happy-path test**

Create `apps/be-01/src/service/event-bus.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import { buildTestServices, createFakePushClient } from '../__tests__/build-services';

describe('EventBus.broadcast', () => {
  const services = buildTestServices();
  afterEach(() => {
    services.metrics.snapshot.broadcastDelivered = 0;
    services.metrics.snapshot.broadcastPushFailed = 0;
    services.pushClient.calls.length = 0;
  });

  it('records, buffers, and pushes a single event', async () => {
    const recorded = await services.eventBus.broadcast('doc:x', { op: 'edit' });

    expect(recorded.subscription).toBe('doc:x');
    expect(recorded.seq).toBe(0);
    expect(recorded.message).toEqual({ op: 'edit' });

    const dbEvents = await services.repo.rangeSince('doc:x', -1);
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0]?.seq).toBe(0);
    expect(dbEvents[0]?.message).toEqual({ op: 'edit' });

    const buffered = services.buffer.since('doc:x', -1);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.seq).toBe(0);

    expect(services.pushClient.calls).toHaveLength(1);
    expect(services.pushClient.calls[0]?.payload).toEqual({
      subscription: 'doc:x',
      seq: 0,
      message: { op: 'edit' },
    });

    expect(services.metrics.snapshot.broadcastDelivered).toBeGreaterThanOrEqual(1);
    expect(services.metrics.snapshot.broadcastPushFailed).toBe(0);
  });

  it('swallows push failures and increments failure counter', async () => {
    const failing = createFakePushClient({ failAfter: 0 });
    const local = buildTestServices({ pushClient: failing });
    try {
      const recorded = await local.eventBus.broadcast('doc:y', { op: 'fail' });
      expect(recorded.seq).toBe(0);

      const dbEvents = await local.repo.rangeSince('doc:y', -1);
      expect(dbEvents).toHaveLength(1);

      const buffered = local.buffer.since('doc:y', -1);
      expect(buffered).toHaveLength(1);

      expect(failing.calls).toHaveLength(1);
      expect(local.metrics.snapshot.broadcastPushFailed).toBe(1);
      expect(local.metrics.snapshot.broadcastDelivered).toBe(0);
    } finally {
      local.cleanup();
    }
  });

  it('returns monotonic seqs across multiple broadcasts', async () => {
    const a = await services.eventBus.broadcast('doc:m', 1);
    const b = await services.eventBus.broadcast('doc:m', 2);
    const c = await services.eventBus.broadcast('doc:m', 3);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/service/event-bus.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 2.3: GREEN — implement `EventBus.broadcast`**

Replace `apps/be-01/src/service/event-bus.ts` body:

```ts
import type { Logger } from '@wbs/observability';

import type { EventSequencer, RecordedEvent } from './event-sequencer';
import type { ReplayBuffer } from './replay-buffer';
import type { PushClient } from './push-client';
import { PushFailed } from './push-client';
import type { BeMetrics } from './be-metrics';

export interface EventBusDeps {
  sequencer: EventSequencer;
  buffer: ReplayBuffer;
  pushClient: PushClient;
  metrics: BeMetrics;
  logger: Logger;
}

export class EventBus {
  constructor(private readonly deps: EventBusDeps) {}

  async broadcast(subscription: string, message: unknown): Promise<RecordedEvent> {
    const recorded = await this.deps.sequencer.recordEvent(subscription, message);
    this.deps.buffer.record(subscription, recorded.seq, message);
    try {
      const { delivered } = await this.deps.pushClient.push({
        subscription,
        seq: recorded.seq,
        message,
      });
      this.deps.metrics.broadcastDelivered(delivered);
    } catch (err) {
      if (err instanceof PushFailed) {
        this.deps.metrics.broadcastPushFailed();
        this.deps.logger.warn({ err, subscription, seq: recorded.seq }, 'broadcast push failed');
      } else {
        throw err;
      }
    }
    return recorded;
  }
}
```

- [ ] **Step 2.4: GREEN — verify**

Run: `cd apps/be-01 && bun test src/service/event-bus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 2.5: Commit**

```bash
git add apps/be-01/src/service/event-bus.ts apps/be-01/src/service/event-bus.test.ts
git commit -m "feat(be-01): EventBus.broadcast — record + buffer + push with failure swallow"
```

---

## Task 3: `ReplayOrchestrator.replay` implementation

**Files:**

- Modify: `apps/be-01/src/service/replay-orchestrator.ts`
- Create: `apps/be-01/src/service/replay-orchestrator.test.ts`

- [ ] **Step 3.1: RED — write failing tests covering all algorithm branches**

Create `apps/be-01/src/service/replay-orchestrator.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import { buildTestServices, createFakePushClient } from '../__tests__/build-services';

const ctx = { clientId: 'c-1', connectionId: 'n-1', traceId: 't-1' };

describe('ReplayOrchestrator.replay', () => {
  it('returns out_of_range for an unknown subscription', async () => {
    const s = buildTestServices();
    try {
      const out = await s.replayOrchestrator.replay({ 'doc:never': 5 }, ctx);
      expect(out['doc:never']).toEqual({ status: 'denied', reason: 'out_of_range' });
      expect(s.pushClient.calls).toHaveLength(0);
      expect(s.metrics.snapshot.resumeReplaysDenied).toBe(1);
      expect(s.metrics.snapshot.resumeReplaysReplaying).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  it('serves from the buffer when the buffer covers the gap', async () => {
    const s = buildTestServices();
    try {
      // Seed via eventBus so buffer + repo both populate from seq 0..2
      await s.eventBus.broadcast('doc:x', { v: 0 });
      await s.eventBus.broadcast('doc:x', { v: 1 });
      await s.eventBus.broadcast('doc:x', { v: 2 });
      s.pushClient.calls.length = 0;
      s.metrics.snapshot.broadcastDelivered = 0;

      const out = await s.replayOrchestrator.replay({ 'doc:x': -1 }, ctx);
      expect(out['doc:x']).toEqual({ status: 'replaying', count: 3 });
      expect(s.pushClient.calls.map((c) => c.payload.seq)).toEqual([0, 1, 2]);
      expect(s.metrics.snapshot.resumeReplaysReplaying).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  it('falls through to DB when the buffer does not cover the gap', async () => {
    const s = buildTestServices();
    try {
      await s.eventBus.broadcast('doc:x', { v: 0 });
      await s.eventBus.broadcast('doc:x', { v: 1 });
      await s.eventBus.broadcast('doc:x', { v: 2 });
      // Simulate buffer eviction by recreating it; repo retains all 3.
      const fresh = buildTestServices({
        // share nothing — but reseed the same DB? simpler: rebuild repo over same db
      });
      try {
        // Manually populate fresh.repo to simulate persistent state
        await fresh.repo.recordEvent('doc:x', { v: 0 }, 1);
        await fresh.repo.recordEvent('doc:x', { v: 1 }, 2);
        await fresh.repo.recordEvent('doc:x', { v: 2 }, 3);
        fresh.pushClient.calls.length = 0;
        const out = await fresh.replayOrchestrator.replay({ 'doc:x': -1 }, ctx);
        expect(out['doc:x']).toEqual({ status: 'replaying', count: 3 });
        expect(fresh.pushClient.calls.map((c) => c.payload.seq)).toEqual([0, 1, 2]);
      } finally {
        fresh.cleanup();
      }
    } finally {
      s.cleanup();
    }
  });

  it('preserves seq order across the replay burst', async () => {
    const s = buildTestServices();
    try {
      for (let i = 0; i < 10; i++) {
        await s.eventBus.broadcast('doc:o', { i });
      }
      s.pushClient.calls.length = 0;

      await s.replayOrchestrator.replay({ 'doc:o': -1 }, ctx);
      expect(s.pushClient.calls.map((c) => c.payload.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      s.cleanup();
    }
  });

  it('partial push failure: returns smaller count, continues remaining pushes', async () => {
    const failing = createFakePushClient({ failAfter: 2 });
    const s = buildTestServices({ pushClient: failing });
    try {
      // Seed 5 events. broadcast also pushes — disable that contribution by recording via repo directly.
      for (let i = 0; i < 5; i++) await s.repo.recordEvent('doc:p', { i }, i + 1);
      failing.calls.length = 0;
      // failAfter=2 means: 1st OK, 2nd OK, 3rd-onwards throw
      failing.failAfter = 2;

      const out = await s.replayOrchestrator.replay({ 'doc:p': -1 }, ctx);
      expect(out['doc:p']).toEqual({ status: 'replaying', count: 2 });
      expect(failing.calls.map((c) => c.payload.seq)).toEqual([0, 1, 2, 3, 4]); // all attempted
    } finally {
      s.cleanup();
    }
  });

  it('mixes replaying and denied across multiple subscriptions', async () => {
    const s = buildTestServices();
    try {
      await s.eventBus.broadcast('a', { x: 1 });
      await s.eventBus.broadcast('a', { x: 2 });
      s.pushClient.calls.length = 0;

      const out = await s.replayOrchestrator.replay({ a: -1, b: 99 }, ctx);
      expect(out['a']).toEqual({ status: 'replaying', count: 2 });
      expect(out['b']).toEqual({ status: 'denied', reason: 'out_of_range' });
      expect(s.metrics.snapshot.resumeReplaysReplaying).toBe(1);
      expect(s.metrics.snapshot.resumeReplaysDenied).toBe(1);
    } finally {
      s.cleanup();
    }
  });
});
```

- [ ] **Step 3.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/service/replay-orchestrator.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 3.3: GREEN — implement `ReplayOrchestrator.replay`**

Replace `apps/be-01/src/service/replay-orchestrator.ts` body:

```ts
import type { Logger } from '@wbs/observability';

import type { EventLogRepo, RecordedEvent } from '../repository/event-log';
import type { ReplayBuffer } from './replay-buffer';
import type { PushClient } from './push-client';
import { PushFailed } from './push-client';
import type { BeMetrics } from './be-metrics';

export interface ReplayOrchestratorDeps {
  buffer: ReplayBuffer;
  repo: EventLogRepo;
  pushClient: PushClient;
  metrics: BeMetrics;
  logger: Logger;
}

export type ResumeStatus =
  | { status: 'replaying'; count: number }
  | { status: 'denied'; reason: 'out_of_range' };

export interface ResumeContext {
  clientId: string | null;
  connectionId: string | null;
  traceId: string;
}

interface BufferEvent {
  seq: number;
  message: unknown;
}

export class ReplayOrchestrator {
  constructor(private readonly deps: ReplayOrchestratorDeps) {}

  async replay(
    points: Record<string, number>,
    _ctx: ResumeContext,
  ): Promise<Record<string, ResumeStatus>> {
    const result: Record<string, ResumeStatus> = {};
    for (const [subscription, since] of Object.entries(points)) {
      const events = await this.collectEvents(subscription, since);
      if (events === 'denied') {
        result[subscription] = { status: 'denied', reason: 'out_of_range' };
        this.deps.metrics.resumeReplays('denied');
        continue;
      }
      let pushed = 0;
      for (const ev of events) {
        try {
          await this.deps.pushClient.push({ subscription, seq: ev.seq, message: ev.message });
          pushed += 1;
        } catch (err) {
          if (err instanceof PushFailed) {
            this.deps.logger.warn({ err, subscription, seq: ev.seq }, 'replay push failed');
          } else {
            throw err;
          }
        }
      }
      result[subscription] = { status: 'replaying', count: pushed };
      this.deps.metrics.resumeReplays('replaying');
    }
    return result;
  }

  private async collectEvents(
    subscription: string,
    since: number,
  ): Promise<BufferEvent[] | 'denied'> {
    const bufferOldest = this.deps.buffer.oldestSeq(subscription);
    if (bufferOldest !== null && bufferOldest <= since + 1) {
      return this.deps.buffer
        .since(subscription, since)
        .map((e) => ({ seq: e.seq, message: e.message }));
    }
    const dbOldest = await this.deps.repo.oldestSeq(subscription);
    if (dbOldest === null || dbOldest > since + 1) {
      return 'denied';
    }
    const rows: RecordedEvent[] = await this.deps.repo.rangeSince(subscription, since);
    return rows.map((r) => ({ seq: r.seq, message: r.message }));
  }
}
```

- [ ] **Step 3.4: GREEN — verify**

Run: `cd apps/be-01 && bun test src/service/replay-orchestrator.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3.5: Commit**

```bash
git add apps/be-01/src/service/replay-orchestrator.ts apps/be-01/src/service/replay-orchestrator.test.ts
git commit -m "feat(be-01): ReplayOrchestrator buffer-first-then-DB algorithm with partial-failure tolerance"
```

---

## Task 4: `RetentionTimer` implementation

**Files:**

- Modify: `apps/be-01/src/service/retention-timer.ts`
- Create: `apps/be-01/src/service/retention-timer.test.ts`

- [ ] **Step 4.1: RED — write failing tests using injected timer**

Create `apps/be-01/src/service/retention-timer.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createLogger } from '@wbs/observability';
import { RetentionTimer } from './retention-timer';
import { createFakeBeMetrics } from '../__tests__/build-services';
import type { EventLogRepo, RecordedEvent } from '../repository/event-log';

interface FakeRepoOpts {
  pruneImpl?: () => Promise<number>;
  oldestSeqImpl?: () => Promise<number | null>;
}

function makeRepo(opts: FakeRepoOpts = {}): EventLogRepo & { pruneCalls: number } {
  const repo = {
    pruneCalls: 0,
    async recordEvent(
      subscription: string,
      message: unknown,
      createdAt: number,
    ): Promise<RecordedEvent> {
      return Promise.resolve({ subscription, seq: 0, message, createdAt });
    },
    async rangeSince(): Promise<RecordedEvent[]> {
      return Promise.resolve([]);
    },
    async oldestSeq(): Promise<number | null> {
      return opts.oldestSeqImpl ? opts.oldestSeqImpl() : Promise.resolve(null);
    },
    async pruneBeyond(): Promise<number> {
      repo.pruneCalls += 1;
      return opts.pruneImpl ? opts.pruneImpl() : Promise.resolve(0);
    },
  };
  return repo;
}

interface FakeTimer {
  setIntervalImpl: (cb: () => void, ms: number) => number;
  clearIntervalImpl: (handle: number) => void;
  fire(): void;
  intervals: { handle: number; ms: number; cb: () => void }[];
}

function createFakeTimer(): FakeTimer {
  const intervals: FakeTimer['intervals'] = [];
  let nextHandle = 1;
  return {
    intervals,
    setIntervalImpl: (cb, ms) => {
      const handle = nextHandle++;
      intervals.push({ handle, ms, cb });
      return handle;
    },
    clearIntervalImpl: (h) => {
      const i = intervals.findIndex((x) => x.handle === h);
      if (i >= 0) intervals.splice(i, 1);
    },
    fire() {
      for (const i of intervals) i.cb();
    },
  };
}

describe('RetentionTimer', () => {
  it('fires once immediately and on each interval tick', async () => {
    const repo = makeRepo();
    const timer = createFakeTimer();
    const t = new RetentionTimer({
      repo,
      metrics: createFakeBeMetrics(),
      logger: createLogger({ service: 'test' }),
      intervalMs: 60_000,
      maxPerSubscription: 10_000,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });
    t.start();
    // immediate tick is async; await microtasks
    await Promise.resolve();
    await Promise.resolve();
    expect(repo.pruneCalls).toBe(1);

    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(repo.pruneCalls).toBe(2);

    await t.stop();
    expect(timer.intervals).toHaveLength(0);
  });

  it('logs but does not throw when a tick errors, and keeps timing', async () => {
    let calls = 0;
    const repo = makeRepo({
      pruneImpl: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('disk full'));
        return Promise.resolve(0);
      },
    });
    const timer = createFakeTimer();
    const t = new RetentionTimer({
      repo,
      metrics: createFakeBeMetrics(),
      logger: createLogger({ service: 'test' }),
      intervalMs: 60_000,
      maxPerSubscription: 10_000,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });
    t.start();
    await Promise.resolve();
    await Promise.resolve();
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    await t.stop();
  });

  it('stop() awaits the in-flight tick before resolving', async () => {
    let release: (() => void) | null = null;
    const repo = makeRepo({
      pruneImpl: () =>
        new Promise<number>((resolve) => {
          release = () => {
            resolve(0);
          };
        }),
    });
    const timer = createFakeTimer();
    const t = new RetentionTimer({
      repo,
      metrics: createFakeBeMetrics(),
      logger: createLogger({ service: 'test' }),
      intervalMs: 60_000,
      maxPerSubscription: 10_000,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    });
    t.start();
    await Promise.resolve();
    let stopped = false;
    const stopPromise = t.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
```

- [ ] **Step 4.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/service/retention-timer.test.ts`
Expected: FAIL — `not implemented`.

- [ ] **Step 4.3: GREEN — implement `RetentionTimer`**

Replace `apps/be-01/src/service/retention-timer.ts`:

```ts
import type { Logger } from '@wbs/observability';

import { runRetention } from './retention-job';
import type { EventLogRepo } from '../repository/event-log';
import type { BeMetrics } from './be-metrics';

export interface RetentionTimerDeps {
  repo: EventLogRepo;
  metrics: BeMetrics;
  logger: Logger;
  intervalMs: number;
  maxPerSubscription: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export class RetentionTimer {
  private handle: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: RetentionTimerDeps) {}

  start(): void {
    if (this.handle !== null) return;
    const setIntervalFn = this.deps.setIntervalImpl ?? setInterval;
    this.handle = setIntervalFn(() => {
      void this.tick();
    }, this.deps.intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) {
      const clearIntervalFn = this.deps.clearIntervalImpl ?? clearInterval;
      clearIntervalFn(this.handle);
      this.handle = null;
    }
    if (this.inflight) await this.inflight;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inflight) return; // skip overlapping fires
    const work = (async () => {
      try {
        await runRetention(this.deps.repo, { maxPerSubscription: this.deps.maxPerSubscription });
      } catch (err) {
        this.deps.logger.error({ err }, 'retention tick failed');
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = work;
    await work;
  }
}
```

- [ ] **Step 4.4: GREEN — verify**

Run: `cd apps/be-01 && bun test src/service/retention-timer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4.5: Commit**

```bash
git add apps/be-01/src/service/retention-timer.ts apps/be-01/src/service/retention-timer.test.ts
git commit -m "feat(be-01): RetentionTimer with injected scheduler + clean shutdown"
```

---

## Task 5: Wire `BeServices` into `buildApp`

**Files:**

- Modify: `apps/be-01/src/app.ts`
- Modify: `apps/be-01/src/health.test.ts`
- Modify: `apps/be-01/src/migrate.test.ts`
- Modify: `apps/be-01/src/controller/internal.integration.test.ts`
- Create: `apps/be-01/src/controller/forward-pure-ack.integration.test.ts`

- [ ] **Step 5.1: RED — write failing test for new `services` option**

Create `apps/be-01/src/controller/forward-pure-ack.integration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { buildTestServices } from '../__tests__/build-services';
import { buildApp } from '../app';

const SECRET = 'test-secret-must-be-32-chars-at-least-!';

describe('POST /internal/forward — pure ack', () => {
  it('does not record any event on a valid forward', async () => {
    const services = buildTestServices();
    try {
      const app = buildApp({
        migrationsApplied: true,
        internalAuthSecret: SECRET,
        services: { eventBus: services.eventBus, replayOrchestrator: services.replayOrchestrator },
      });
      const res = await app.handle(
        new Request('http://localhost/internal/forward', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-auth': SECRET,
            'x-client-id': 'u-1',
            'x-connection-id': 'c-1',
          },
          body: JSON.stringify({ message: { type: 'edit' }, trace_id: 't-1' }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ack: boolean; push_responses: unknown[] };
      expect(body.ack).toBe(true);
      expect(body.push_responses).toEqual([]);

      const dbRows = await services.repo.rangeSince('any', -1);
      expect(dbRows).toHaveLength(0);
      expect(services.pushClient.calls).toHaveLength(0);
    } finally {
      services.cleanup();
    }
  });
});
```

- [ ] **Step 5.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/controller/forward-pure-ack.integration.test.ts`
Expected: FAIL — `services` is not a valid option on `AppOptions`.

- [ ] **Step 5.3: GREEN — update `buildApp`**

Replace `apps/be-01/src/app.ts` entirely:

```ts
import { createLogger } from '@wbs/observability';
import { observabilityPlugin } from '@wbs/observability/server';
import { Elysia } from 'elysia';

import { internalController } from './controller/internal.controller';
import { smokeController } from './controller/smoke.controller';
import type { EventBus } from './service/event-bus';
import type { ReplayOrchestrator } from './service/replay-orchestrator';

export interface BeServices {
  eventBus: EventBus;
  replayOrchestrator: ReplayOrchestrator;
}

export interface AppOptions {
  migrationsApplied: boolean;
  services: BeServices;
  version?: string;
  internalAuthSecret?: string;
}

const DEV_INTERNAL_SECRET = 'development-secret-32-characters!!!';

export function buildApp(opts: AppOptions) {
  const logger = createLogger({ service: 'be-01', version: opts.version });

  return new Elysia()
    .use(observabilityPlugin({ service: 'be-01' }))
    .decorate('logger', logger)
    .use(smokeController)
    .use(
      internalController({
        secret: opts.internalAuthSecret ?? DEV_INTERNAL_SECRET,
        onForward: () => Promise.resolve({ push_responses: [] as unknown[] }),
        onResume: (points, ctx) => opts.services.replayOrchestrator.replay(points, ctx),
      }),
    )
    .get('/health', ({ set }) => {
      if (!opts.migrationsApplied) {
        set.status = 503;
        return { status: 'migrating' };
      }
      return { status: 'ok' };
    });
}
```

- [ ] **Step 5.4: GREEN — verify forward-pure-ack passes**

Run: `cd apps/be-01 && bun test src/controller/forward-pure-ack.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5.5: REFACTOR — update existing tests for new `services` option**

Modify `apps/be-01/src/health.test.ts` to construct `services`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import { buildTestServices } from './__tests__/build-services';
import { buildApp } from './app';

describe('GET /health', () => {
  let services = buildTestServices();
  afterEach(() => {
    services.cleanup();
    services = buildTestServices();
  });

  it('returns 200 with status:"ok" when ready', async () => {
    const app = buildApp({
      migrationsApplied: true,
      services: { eventBus: services.eventBus, replayOrchestrator: services.replayOrchestrator },
    });
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 503 while migrations still running', async () => {
    const app = buildApp({
      migrationsApplied: false,
      services: { eventBus: services.eventBus, replayOrchestrator: services.replayOrchestrator },
    });
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
  });
});
```

Modify `apps/be-01/src/migrate.test.ts` analogously: import `buildTestServices`, pass `services: { eventBus, replayOrchestrator }` into every `buildApp(...)` call.

Modify `apps/be-01/src/controller/internal.integration.test.ts`:

- For every `buildApp(...)` call, supply `services` from `buildTestServices()`.
- Replace the existing `POST /internal/resume` test that asserted the stub's behavior. The new test should seed events via `services.repo.recordEvent` directly, then call resume, then assert the orchestrator's response shape and that pushes were recorded:

```ts
it('replays seeded events end-to-end via the real orchestrator', async () => {
  const services = buildTestServices();
  try {
    await services.repo.recordEvent('doc:a', { v: 0 }, 1);
    await services.repo.recordEvent('doc:a', { v: 1 }, 2);
    await services.repo.recordEvent('doc:a', { v: 2 }, 3);
    const app = buildApp({
      migrationsApplied: true,
      internalAuthSecret: SECRET,
      services: { eventBus: services.eventBus, replayOrchestrator: services.replayOrchestrator },
    });
    const res = await app.handle(
      new Request('http://localhost/internal/resume', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-auth': SECRET,
          'x-client-id': 'u-1',
          'x-connection-id': 'c-1',
        },
        body: JSON.stringify({ resume_points: { 'doc:a': -1 }, trace_id: 't-1' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { status: string; count: number }>;
    expect(body['doc:a']).toEqual({ status: 'replaying', count: 3 });
    expect(services.pushClient.calls.map((c) => c.payload.seq)).toEqual([0, 1, 2]);
  } finally {
    services.cleanup();
  }
});
```

- [ ] **Step 5.6: GREEN — verify the full suite**

Run: `cd apps/be-01 && bun test`
Expected: PASS (all tests, including the rewritten `internal.integration.test.ts` resume test).

- [ ] **Step 5.7: Commit**

```bash
git add apps/be-01/src/app.ts apps/be-01/src/health.test.ts apps/be-01/src/migrate.test.ts apps/be-01/src/controller/internal.integration.test.ts apps/be-01/src/controller/forward-pure-ack.integration.test.ts
git commit -m "refactor(be-01): buildApp accepts BeServices; onForward pure ack; onResume delegates to orchestrator"
```

---

## Task 6: Wire `main.ts` runtime composition

**Files:**

- Modify: `apps/be-01/src/main.ts`

This task is a manual smoke against a running BE — there is no automated test for `main.ts` end-to-end (a full process boot test is out of scope; the integration tests in Tasks 2-5 already cover what `main.ts` composes).

- [ ] **Step 6.1: GREEN — replace `main.ts`**

Replace `apps/be-01/src/main.ts`:

```ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { createLogger } from '@wbs/observability';

import { buildApp } from './app';
import { loadConfig } from './config';
import { runMigrations } from './repository/migrate';
import { DrizzleEventLogRepo } from './repository/event-log';
import { EventSequencer } from './service/event-sequencer';
import { ReplayBuffer } from './service/replay-buffer';
import { PushClient } from './service/push-client';
import { EventBus } from './service/event-bus';
import { ReplayOrchestrator } from './service/replay-orchestrator';
import { RetentionTimer } from './service/retention-timer';
import { createBeMetrics } from './service/be-metrics-otel';

const cfg = loadConfig();
const logger = createLogger({ service: 'be-01', level: cfg.LOG_LEVEL });
const dbPath = process.env['DB_PATH'] ?? './local.db';

const sqlite = new Database(dbPath);
const drizzleDb = drizzle(sqlite);
const repo = new DrizzleEventLogRepo(drizzleDb);
const buffer = new ReplayBuffer({ maxPerSubscription: 1000, maxAgeMs: 5 * 60_000 });
const sequencer = new EventSequencer(repo);
const pushClient = new PushClient({
  gwUrl: cfg.GW_URL,
  secret: cfg.INTERNAL_AUTH_SECRET,
});
const metrics = createBeMetrics();
const eventBus = new EventBus({ sequencer, buffer, pushClient, metrics, logger });
const replayOrchestrator = new ReplayOrchestrator({
  buffer,
  repo,
  pushClient,
  metrics,
  logger,
});
const retention = new RetentionTimer({
  repo,
  metrics,
  logger,
  intervalMs: 60_000,
  maxPerSubscription: 10_000,
});

const state = { migrationsApplied: false };
const app = buildApp({
  get migrationsApplied() {
    return state.migrationsApplied;
  },
  services: { eventBus, replayOrchestrator },
  version: process.env['VERSION'],
  internalAuthSecret: cfg.INTERNAL_AUTH_SECRET,
});

app.listen(cfg.PORT, () => {
  logger.info({ port: cfg.PORT }, 'be-01 listening (migrating)');
  try {
    runMigrations(dbPath, './drizzle');
    state.migrationsApplied = true;
    retention.start();
    logger.info({ port: cfg.PORT }, 'be-01 ready');
  } catch (err) {
    logger.error({ err }, 'migrations failed');
    process.exit(1);
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await retention.stop();
  sqlite.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
```

Note: this references `./service/be-metrics-otel` which Task 7 creates. Until then, `main.ts` will fail to typecheck — that's expected. We commit the structure now and finish in Task 7.

- [ ] **Step 6.2: REFACTOR — squash later, no commit yet**

Defer the commit to Task 7; if a commit is desired here, stub `createBeMetrics` to return a no-op `BeMetrics` so typecheck passes. Otherwise proceed directly to Task 7.

---

## Task 7: Real `BeMetrics` over `@wbs/observability`

**Files:**

- Create: `apps/be-01/src/service/be-metrics-otel.ts`
- Create: `apps/be-01/src/__tests__/metrics.integration.test.ts`

- [ ] **Step 7.1: RED — write failing /metrics integration test**

Create `apps/be-01/src/__tests__/metrics.integration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createLogger } from '@wbs/observability';

import { buildApp } from '../app';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { ReplayBuffer } from '../service/replay-buffer';
import { EventSequencer } from '../service/event-sequencer';
import { EventBus } from '../service/event-bus';
import { ReplayOrchestrator } from '../service/replay-orchestrator';
import { createBeMetrics } from '../service/be-metrics-otel';
import { createFakePushClient } from './build-services';
import type { PushClient } from '../service/push-client';

describe('/metrics exposes BE Layer-A counters', () => {
  it('renders broadcast and resume counters in Prometheus format after activity', async () => {
    const db = new Database(':memory:');
    const drizzleDb = drizzle(db);
    migrate(drizzleDb, { migrationsFolder: 'drizzle' });
    const logger = createLogger({ service: 'be-01-test' });
    const repo = new DrizzleEventLogRepo(drizzleDb);
    const buffer = new ReplayBuffer({ maxPerSubscription: 1000, maxAgeMs: 60_000 });
    const sequencer = new EventSequencer(repo);
    const metrics = createBeMetrics();
    const fakePush = createFakePushClient();
    const pushClient = fakePush as unknown as PushClient;
    const eventBus = new EventBus({ sequencer, buffer, pushClient, metrics, logger });
    const replayOrchestrator = new ReplayOrchestrator({
      buffer,
      repo,
      pushClient,
      metrics,
      logger,
    });
    try {
      const app = buildApp({
        migrationsApplied: true,
        services: { eventBus, replayOrchestrator },
      });
      // Drive activity
      await eventBus.broadcast('doc:m', { v: 1 });
      await replayOrchestrator.replay(
        { 'doc:m': -1, 'doc:never': 99 },
        { clientId: null, connectionId: null, traceId: 't' },
      );

      const res = await app.handle(new Request('http://localhost/metrics/server'));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/broadcast_delivered_total/);
      expect(body).toMatch(/broadcast_push_failed_total/);
      expect(body).toMatch(/resume_replays_total/);
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 7.2: RED — verify failure**

Run: `cd apps/be-01 && bun test src/__tests__/metrics.integration.test.ts`
Expected: FAIL — `createBeMetrics` does not exist.

- [ ] **Step 7.3: GREEN — implement `createBeMetrics`**

Create `apps/be-01/src/service/be-metrics-otel.ts`:

```ts
import { Counter, Gauge } from '@wbs/observability';

import type { BeMetrics, ResumeResult } from './be-metrics';

export function createBeMetrics(): BeMetrics {
  const broadcastDelivered = new Counter(
    'broadcast_delivered_total',
    'Events successfully delivered to gw via /internal/push',
  );
  const broadcastPushFailed = new Counter(
    'broadcast_push_failed_total',
    'EventBus.broadcast pushes that exhausted retries',
  );
  const resumeReplays = new Counter(
    'resume_replays_total',
    'Resume replays per subscription, labeled by result',
  );
  const eventLogRowsGauge = new Gauge(
    'event_log_rows_total',
    'Approximate row count in event_log (sampled at retention tick)',
  );

  let lastEventLogRows = 0;

  return {
    broadcastDelivered(count: number): void {
      broadcastDelivered.inc(count);
    },
    broadcastPushFailed(): void {
      broadcastPushFailed.inc();
    },
    resumeReplays(result: ResumeResult): void {
      resumeReplays.inc(1, { result });
    },
    eventLogRows(total: number): void {
      const delta = total - lastEventLogRows;
      lastEventLogRows = total;
      eventLogRowsGauge.set(delta);
    },
  };
}
```

The `Gauge.set` workaround (computing delta over an UpDownCounter) is necessary because the existing `@wbs/observability` `Gauge.set` is implemented as `add` under the hood — see `libs/observability/src/metrics.ts:32-39`. A future change to `@wbs/observability` could expose a real observable gauge; until then, delta-tracking gives correct exposed values.

- [ ] **Step 7.4: GREEN — verify metrics test**

Run: `cd apps/be-01 && bun test src/__tests__/metrics.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7.5: GREEN — verify `main.ts` typechecks**

Run: `cd apps/be-01 && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors).

- [ ] **Step 7.6: Commit**

```bash
git add apps/be-01/src/main.ts apps/be-01/src/service/be-metrics-otel.ts apps/be-01/src/__tests__/metrics.integration.test.ts
git commit -m "feat(be-01): real BeMetrics over @wbs/observability + main.ts wires runtime composition"
```

---

## Task 8: End-to-end resume vs. fake gw

**Files:**

- Create: `apps/be-01/src/__tests__/resume-vs-gw.integration.test.ts`

This test stands up a real `Bun.serve` listener acting as a fake gw and exercises the full HTTP path of `PushClient` → fake gw — proving the `PushClient` retry/transport layer composes correctly with the orchestrator.

- [ ] **Step 8.1: RED — write the failing E2E test**

Create `apps/be-01/src/__tests__/resume-vs-gw.integration.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createLogger } from '@wbs/observability';

import { DrizzleEventLogRepo } from '../repository/event-log';
import { ReplayBuffer } from '../service/replay-buffer';
import { PushClient } from '../service/push-client';
import { ReplayOrchestrator } from '../service/replay-orchestrator';
import { createFakeBeMetrics } from './build-services';

interface FakeGw {
  url: string;
  pushes: { subscription: string; seq: number; message: unknown }[];
  failOnSeq?: number;
  stop: () => void;
}

function startFakeGw(): FakeGw {
  const pushes: FakeGw['pushes'] = [];
  const fake: FakeGw = {
    url: '',
    pushes,
    stop: () => {
      /* set after Bun.serve */
    },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/internal/push' || req.method !== 'POST') {
        return new Response('not found', { status: 404 });
      }
      const body = (await req.json()) as { subscription: string; seq: number; message: unknown };
      if (typeof fake.failOnSeq === 'number' && body.seq >= fake.failOnSeq) {
        return new Response('boom', { status: 503 });
      }
      pushes.push(body);
      return new Response(JSON.stringify({ delivered_to_sockets: 1 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  fake.url = `http://localhost:${String(server.port)}`;
  fake.stop = () => server.stop(true);
  return fake;
}

describe('resume vs. fake gw end-to-end', () => {
  let gw: FakeGw | null = null;
  afterEach(() => {
    gw?.stop();
    gw = null;
  });

  it('replays seeded events to the gw in seq order before the response returns', async () => {
    gw = startFakeGw();
    const db = new Database(':memory:');
    const drizzleDb = drizzle(db);
    migrate(drizzleDb, { migrationsFolder: 'drizzle' });
    const logger = createLogger({ service: 'test' });
    const repo = new DrizzleEventLogRepo(drizzleDb);
    const buffer = new ReplayBuffer({ maxPerSubscription: 1000, maxAgeMs: 60_000 });
    for (let i = 0; i < 5; i++) await repo.recordEvent('doc:x', { i }, i + 1);

    const pushClient = new PushClient({
      gwUrl: gw.url,
      secret: 'irrelevant-for-fake-gw',
      maxRetries: 1,
    });
    const orchestrator = new ReplayOrchestrator({
      buffer,
      repo,
      pushClient,
      metrics: createFakeBeMetrics(),
      logger,
    });

    const out = await orchestrator.replay(
      { 'doc:x': -1 },
      { clientId: 'c', connectionId: 'n', traceId: 't' },
    );
    expect(out['doc:x']).toEqual({ status: 'replaying', count: 5 });
    expect(gw.pushes.map((p) => p.seq)).toEqual([0, 1, 2, 3, 4]);
    db.close();
  });

  it('reports a smaller count when one push fails after retries', async () => {
    gw = startFakeGw();
    gw.failOnSeq = 2; // seqs 2,3,4 fail
    const db = new Database(':memory:');
    const drizzleDb = drizzle(db);
    migrate(drizzleDb, { migrationsFolder: 'drizzle' });
    const logger = createLogger({ service: 'test' });
    const repo = new DrizzleEventLogRepo(drizzleDb);
    const buffer = new ReplayBuffer({ maxPerSubscription: 1000, maxAgeMs: 60_000 });
    for (let i = 0; i < 5; i++) await repo.recordEvent('doc:y', { i }, i + 1);

    const pushClient = new PushClient({
      gwUrl: gw.url,
      secret: 'irrelevant',
      maxRetries: 1, // keep test fast
    });
    const orchestrator = new ReplayOrchestrator({
      buffer,
      repo,
      pushClient,
      metrics: createFakeBeMetrics(),
      logger,
    });
    const out = await orchestrator.replay(
      { 'doc:y': -1 },
      { clientId: 'c', connectionId: 'n', traceId: 't' },
    );
    expect(out['doc:y']).toEqual({ status: 'replaying', count: 2 });
    expect(gw.pushes.map((p) => p.seq)).toEqual([0, 1]);
    db.close();
  });
});
```

- [ ] **Step 8.2: GREEN — verify**

Run: `cd apps/be-01 && bun test src/__tests__/resume-vs-gw.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8.3: Commit**

```bash
git add apps/be-01/src/__tests__/resume-vs-gw.integration.test.ts
git commit -m "test(be-01): resume-vs-fake-gw E2E covering ordered burst and partial failure"
```

---

## Task 9: Type, lint, format, full-suite, OpenSpec validation

- [ ] **Step 9.1: typecheck**

Run: `bunx nx typecheck be-01`
Expected: PASS. Fix any errors inline (most likely culprit: `BeServices` import path or unused-import lint rule on `eventBus` in places that only need `replayOrchestrator`).

- [ ] **Step 9.2: lint**

Run: `bunx nx lint be-01`
Expected: PASS. Confirm the `no-restricted-imports` rule still fires only outside `repository/`. Fix any issues.

- [ ] **Step 9.3: format**

Run: `bunx nx format:write`
Verify clean: `bunx nx format:check`

- [ ] **Step 9.4: full BE test suite**

Run: `bunx nx test be-01`
Expected: PASS (all tests across `event-bus`, `replay-orchestrator`, `retention-timer`, `be-metrics`, `health`, `migrate`, `internal.integration`, `forward-pure-ack.integration`, `metrics.integration`, `resume-vs-gw.integration`).

- [ ] **Step 9.5: workspace-wide test run (sanity)**

Run: `bunx nx run-many -t test`
Expected: PASS — no other apps/libs affected by this change.

- [ ] **Step 9.6: OpenSpec validation**

Run: `openspec validate wire-be-01-runtime-layer-a --json`
Expected: `valid: true`. If it fails because the parent `openspec/specs/` doesn't yet have `backend-foundation`, that's expected — `scaffold-tech-setup` archives first; this change archives second. Note in the verify artifact.

- [ ] **Step 9.7: Commit format/lint cleanup if any**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(be-01): format + lint pass after Layer-A wiring"
```

---

## Self-Review checklist (run before marking the plan complete)

- **Spec coverage:**
  - Spec Req 1 (BeServices composition) → Tasks 1, 5, 6
  - Spec Req 2 (ReplayOrchestrator algorithm) → Task 3
  - Spec Req 3 (resume responds after pushes complete) → Task 3, 8
  - Spec Req 4 (EventBus.broadcast contract) → Task 2
  - Spec Req 5 (RetentionTimer lifecycle) → Tasks 4, 6
  - Spec Req 6 (BE Layer-A counters at /metrics) → Tasks 1, 7
  - Spec Req 7 (onForward pure ack) → Task 5
- **Placeholder scan:** none. Every step has concrete code or a concrete command.
- **Type consistency:** `BeServices = {eventBus, replayOrchestrator}` everywhere; `ReplayOrchestrator.replay(points, ctx)` signature stable; `EventBus.broadcast(subscription, message)` returns `RecordedEvent` everywhere.

## Notes for the executor

- **Test isolation**: every integration test that opens a `:memory:` SQLite must call `services.cleanup()` (or `db.close()`) in `finally` to avoid handle leaks across `bun test` files.
- **Fake-vs-real metrics**: tasks 1-6 use `FakeBeMetrics`; task 7 introduces real OTel-backed metrics via `createBeMetrics()`. Both implement the same `BeMetrics` interface.
- **`PushFailed` import location**: `apps/be-01/src/service/push-client.ts` exports the class; import as `import { PushFailed } from './push-client'` from siblings.
- **Migration path in tests**: `migrate(drizzleDb, { migrationsFolder: 'drizzle' })` works because tests run with `cwd: apps/be-01` (per `project.json:32`).
- **No commits to gw-01, fe-01, libs/**: any diff outside `apps/be-01/src/` and `openspec/changes/wire-be-01-runtime-layer-a/` is out of scope; revert if it shows up.
