import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clockOf } from '@wbs/core';
import { describe, expect, it } from 'bun:test';

/**
 * Both service locations during extraction. Core owns the moved services;
 * be-01 retains compatibility reexports and the publication services that have
 * not moved yet.
 */
const FOLDERS = ['apps/be-01/src/service', 'libs/core/src/service'];
const ROOT = join(import.meta.dir, '../../../..');

/**
 * The three classes that keep a `now` of their own, and why each is not a
 * stamper: every one of them **ages its own entries** and writes no row.
 *
 * `ReplayBuffer` drops events past an age, `RetentionTimer` decides when to
 * prune, `LoginThrottle` forgets attempts. In all three suites the passage of
 * time is the subject rather than a detail to hold still, so a `now` that the
 * test steps by hand is the point of the option.
 */
const AGE_THEIR_OWN_ENTRIES = new Set([
  'replay-buffer.ts',
  'retention-timer.ts',
  'login-throttle.ts',
]);

function serviceSources(): { name: string; path: string; text: string }[] {
  return FOLDERS.flatMap((folder) =>
    readdirSync(join(ROOT, folder))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({
        name,
        path: join(folder, name),
        text: readFileSync(join(ROOT, folder, name), 'utf8'),
      })),
  );
}

describe('one clock', () => {
  /**
   * An act reads the clock **once** — ADR 0012's sentence, and the reason a
   * `WriteStamp` exists at all. It was seven identical `private stampFor`
   * methods over seven injected `now`s until 2026-09-02, which is seven places
   * for a second reading to appear; now it is `Clock.stampFor`.
   *
   * A text read for `audit.test.ts`'s reason: what has to be refused is a shape
   * — a service growing its own clock back — and no type can state it.
   * The exemptions are named, so re-adding one is a deliberate act with a
   * reader's question attached.
   *
   * Proof: adding `now?: () => number;` to core's CapacityServiceOptions left
   * all four cases green with only the be-01 scan. With both folders scanned,
   * this case failed on expected [], received
   * ["libs/core/src/service/capacity.service.ts"] (2026-09-09).
   */
  it('is the only clock a service that stamps a write reads', () => {
    const growingOne = serviceSources()
      .filter((file) => !AGE_THEIR_OWN_ENTRIES.has(file.name))
      .filter((file) => /\n\s+now\?: \(\) => number;/.test(file.text))
      .map((file) => file.path);

    expect(growingOne).toEqual([]);
  });

  it('is the only place a stamp is built', () => {
    // Proof: restoring private stampFor(actorId: string): WriteStamp on core's
    // CapacityService failed here on expected [], received
    // ["libs/core/src/service/capacity.service.ts"] (2026-09-09).
    const stamping = serviceSources()
      .filter((file) => file.text.includes('stampFor(actorId: string): WriteStamp'))
      .map((file) => file.path);

    expect(stamping).toEqual([]);
  });

  it('is reading real service sources, not an empty list', () => {
    // Both cases above pass on an empty folder listing, for a wrong reason: a
    // renamed directory, a filter that dropped every file.
    const sources = serviceSources();
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((file) => file.name)).toContain('work-item.service.ts');
    expect(sources.some((file) => file.text.includes('this.clock.stampFor('))).toBe(true);
    const coreCapacity = sources.find(
      (file) => file.path === 'libs/core/src/service/capacity.service.ts',
    );
    const coreWorkItems = sources.find(
      (file) => file.path === 'libs/core/src/service/work-item.service.ts',
    );
    const beWorkItems = sources.find(
      (file) => file.path === 'apps/be-01/src/service/work-item.service.ts',
    );
    // Proof: removing the core folder from FOLDERS failed this assertion on
    // Received: undefined while the two shape checks passed (2026-09-09).
    expect(coreCapacity).toBeDefined();
    expect(coreCapacity?.text).toContain('export class CapacityService');
    expect(coreWorkItems).toBeDefined();
    // Proof: removing `export` from core's WorkItemService failed here on
    // Expected to contain "export class WorkItemService" (2026-09-09).
    expect(coreWorkItems?.text).toContain('export class WorkItemService');
    expect(beWorkItems).toBeDefined();
    expect(beWorkItems?.text).toContain("export * from '@wbs/core/service/work-item.service'");
  });

  it('dates one act from one reading of the clock', () => {
    // The rule itself, and the reason `stampFor` is derived from `now` rather
    // than injected beside it: a stamp whose instant did not come from this
    // clock is exactly the drift the type exists to stop.
    let reading = 0;
    const clock = clockOf({
      newId: () => crypto.randomUUID(),
      now: () => {
        reading += 1;
        return reading;
      },
    });

    const stamp = clock.stampFor('u1');

    expect(stamp).toEqual({ at: 1, by: 'u1' });
    expect(reading).toBe(1);
  });
});
