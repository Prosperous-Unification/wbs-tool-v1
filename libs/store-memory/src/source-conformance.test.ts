import { sourceConformance, type SourceUnderTest, unitOfWorkConformance } from '@wbs/conformance';
import { beforeEach, describe, expect, it } from 'bun:test';

import { NOT_OFFERED_BY_MEMORY } from './in-memory-source';
import { projectRow } from './project-fixture';
import { openMemorySource } from './source';

// Proof: after a confirmed `store-memory:test` local-cache hit, a throw in the
// imported conformance source forced Nx to rerun and fail on
// `injected conformance dependency cache fault`.

/**
 * The in-memory source under the same kits the SQLite one runs, and its
 * allowlist.
 *
 * D29: this source may lag, and may not lag quietly. Every case it does not
 * offer is on {@link NOT_OFFERED_BY_MEMORY} with a reason, printed as skipped
 * by name, and counted here.
 */
let latest: SourceUnderTest | null = null;
let latestSource: ReturnType<typeof openMemorySource> | null = null;

const open = (): SourceUnderTest => {
  const held = latest;
  if (held === null) throw new Error('the source was read before it was opened');
  return held;
};

const projectId = 'p1';
const stepId = 'st-1';

beforeEach(async () => {
  const source = openMemorySource();
  const { stores } = source;
  const ownerId = crypto.randomUUID();
  const stamp = { at: 1, by: ownerId };
  await stores.users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    stamp,
  );
  await stores.projects.create(
    projectRow({ id: projectId, name: 'Rewire the shed', ownerId }),
    [{ id: stepId, projectId, name: 'Dev', position: 10 }],
    stamp,
  );
  await stores.steps.add({ id: stepId, projectId, name: 'Dev' }, stamp);
  latest = { stores, projectId, ownerId, stamp, stepId };
  latestSource = source;
});

describe('the in-memory unit of work', () => {
  unitOfWorkConformance(() => {
    const source = latestSource;
    const fixture = latest;
    if (source === null || fixture === null)
      throw new Error('the source was read before it opened');
    return {
      uow: source.uow,
      reader: source.stores,
      projectId: fixture.projectId,
      stamp: fixture.stamp,
    };
  });
});

const report = sourceConformance({ name: 'in-memory', notOffered: NOT_OFFERED_BY_MEMORY }, open);

describe('the in-memory source is certified for what it offers', () => {
  it('skips exactly what its allowlist declares, and nothing else', () => {
    // Two claims, failing for different reasons. A case skipped without a line
    // is a stub nobody declared. An entry naming **no case at all** is a stale
    // line — it excuses nothing while looking like it excuses something.
    //
    // Proof of the first: `'estimates.set:unknown_step'` removed from the
    // allowlist made the kit run that case against the fixtures, which answer
    // `'written'` for a step that is not there — `Expected: "unknown_step" ·
    // Received: "written"`. Proof of the second: a made-up `'steps.renamed'`
    // added to the allowlist failed this on `Expected: [] · Received: [
    // "steps.renamed" ]`. Both watched 2026-09-08.
    //
    // A third fault was injected and is **not** caught: `'steps.rename'`, a
    // case this source passes, added to the allowlist. Both assertions stayed
    // green — the line and the skip agree with each other, which is exactly
    // what a wrongly-excused case looks like from here.
    //
    // What neither can see is an entry naming a case the source would now pass.
    // That is a claim the source makes, and only deleting the line and watching
    // the case run tests it — which is what closing a gap means here.
    // `unknown` first, deliberately: a stale entry also makes the equality
    // below fail, and the equality's message is a diff of two lists while this
    // one names the line. Asserted the other way round, `unknown` could never
    // be the assertion that failed — a check standing behind another check that
    // catches the same fault first is a check that cannot fail.
    expect(report.unknownAllowlistEntries()).toEqual([]);
    expect([...report.skipped].sort()).toEqual([...NOT_OFFERED_BY_MEMORY].sort());
    for (const skipped of NOT_OFFERED_BY_MEMORY) expect(report.ran).not.toContain(skipped);
  });

  it('runs the cases it does offer', () => {
    expect(report.ran.length).toBeGreaterThan(report.skipped.length);
  });
});
