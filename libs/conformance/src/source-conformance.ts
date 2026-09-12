import type { Step, TransactionalStores, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { describe, expect, it } from 'bun:test';

import { certifySourceReport, SOURCE_CONFORMANCE_CASES } from './certification';

/**
 * One source, opened for one case, with the rows a kit needs to hang writes off.
 *
 * `open` is called per case rather than per suite: a kit case that read a
 * source another case had written to would be asserting about an order nobody
 * declared.
 */
export interface SourceUnderTest {
  stores: TransactionalStores;
  projectId: string;
  ownerId: string;
  stamp: WriteStamp;
  /** A step of the project, for the writes that name one. */
  stepId: string;
}

/**
 * What a source says about itself before any case runs.
 *
 * Read at **declaration** time rather than out of {@link SourceUnderTest},
 * because `describe` and `it.skip` are declared before any `beforeEach` has
 * opened anything — the first version read the fixture here and threw
 * `the source was read before it was opened` on every case.
 */
export interface SourceDeclaration {
  /** What the report calls it — `SQLite`, `in-memory`. */
  name: string;
  /**
   * The methods this source stubs, by `store.method` or `store.method:case`
   * (D29). A case whose id is on the list is reported as **not offered**
   * rather than run; a stub with no line here fails the source's own allowlist
   * test.
   */
  notOffered?: readonly string[];
}

/**
 * What a kit run answers: which cases ran and which were not offered.
 *
 * Returned rather than printed, so a source's own test can assert on it. A
 * report nobody can read is how "certified" comes to mean "was not asked".
 */
export interface ConformanceReport {
  ran: string[];
  skipped: string[];
  /**
   * Allowlist entries naming no case in any kit, **read when it is called**.
   *
   * A stale line, or a typo — either way an entry that excuses nothing while
   * looking like it excuses something. It is the half of "the allowlist is
   * honest" that can be checked here; the other half, an entry naming a case
   * the source would actually pass, is a claim the source makes and only
   * running the case can test. Deleting a line and watching the case run is how
   * that one is checked, by hand, when the gap is thought to be closed.
   *
   * A function and not a field: `bun:test` runs a `describe` body **after** the
   * file has finished loading, so a value computed where `sourceConformance`
   * returns is computed before a single case has been declared. Assigned
   * eagerly it read every entry as unknown, including the one that was matched
   * a moment later.
   */
  unknownAllowlistEntries: () => string[];
}

/**
 * Declares one kit case, unless the source says it does not offer it.
 *
 * The skip is **named**, not silent: `bun:test` prints it as a case that did
 * not run, and the report carries it out to the source's allowlist test.
 */
function offered(
  kit: Kit,
  id: string,
  name: string,
  body: (source: SourceUnderTest) => Promise<void>,
): void {
  const { open, report, declared } = kit;
  if (declared.includes(id)) {
    report.skipped.push(id);
    it.skip(`${name} — not offered by this source (${id})`, () => undefined);
    return;
  }
  report.ran.push(id);
  it(name, async () => {
    await body(open());
  });
}

/** What every kit function is handed: the fixture, the report, the allowlist. */
interface Kit {
  open: () => SourceUnderTest;
  report: ConformanceReport;
  declared: readonly string[];
}

/** The step store's contract, as cases any source either passes or fails. */
function stepStoreConformance(kit: Kit): void {
  offered(kit, 'steps.add', 'adds a step and reads it back in the project', async (s) => {
    const added = await s.stores.steps.add(
      { id: crypto.randomUUID(), projectId: s.projectId, name: 'Wiring' },
      s.stamp,
    );
    expect(added.ok).toBe(true);
    const names = (await s.stores.steps.listByProject(s.projectId)).map((each) => each.name);
    expect(names).toContain('Wiring');
  });

  offered(kit, 'steps.rename', 'renames a step it holds', async (s) => {
    const renamed = await s.stores.steps.rename(s.stepId, 'Renamed', s.stamp);
    expect(renamed.ok).toBe(true);
    const found = (await s.stores.steps.listByProject(s.projectId)).find(
      (each: Step) => each.id === s.stepId,
    );
    expect(found?.name).toBe('Renamed');
  });

  offered(kit, 'steps.rename:unknown', 'refuses to rename a step it does not hold', async (s) => {
    const renamed = await s.stores.steps.rename('no-such-step', 'Renamed', s.stamp);
    expect(renamed.ok).toBe(false);
  });
}

/** The estimate store's contract. */
function estimateStoreConformance(kit: Kit): void {
  const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

  offered(kit, 'estimates.set', 'writes one trio per work item and step', async (s) => {
    const workItemId = await aWorkItem(s);
    expect(await s.stores.estimates.set({ workItemId, stepId: s.stepId, ...DAYS }, s.stamp)).toBe(
      'written',
    );
    const held = await s.stores.estimates.listByProject(s.projectId);
    expect(held.map((each) => each.workItemId)).toEqual([workItemId]);
    expect(held.at(0)?.realistic).toBe(2);
  });

  offered(kit, 'estimates.set:replace', 'replaces the trio it already held', async (s) => {
    const workItemId = await aWorkItem(s);
    await s.stores.estimates.set({ workItemId, stepId: s.stepId, ...DAYS }, s.stamp);
    await s.stores.estimates.set(
      { workItemId, stepId: s.stepId, optimistic: 5, realistic: 6, pessimistic: 7 },
      s.stamp,
    );
    const held = await s.stores.estimates.listByProject(s.projectId);
    expect(held).toHaveLength(1);
    expect(held.at(0)?.realistic).toBe(6);
  });

  offered(
    kit,
    'estimates.set:unknown_step',
    'says which reference was missing when the step has gone',
    async (s) => {
      const workItemId = await aWorkItem(s);
      expect(
        await s.stores.estimates.set({ workItemId, stepId: 'no-such-step', ...DAYS }, s.stamp),
      ).toBe('unknown_step');
    },
  );

  offered(kit, 'estimates.remove', 'removes one work item and step, and no other', async (s) => {
    const kept = await aWorkItem(s);
    const removed = await aWorkItem(s);
    await s.stores.estimates.set({ workItemId: kept, stepId: s.stepId, ...DAYS }, s.stamp);
    await s.stores.estimates.set({ workItemId: removed, stepId: s.stepId, ...DAYS }, s.stamp);
    await s.stores.estimates.remove(removed, s.stepId, s.stamp);
    const held = await s.stores.estimates.listByProject(s.projectId);
    expect(held.map((each) => each.workItemId)).toEqual([kept]);
  });
}

/** The directory store's contract, for the parts a plan writes through. */
function directoryStoreConformance(kit: Kit): void {
  offered(kit, 'directory.addTag', 'adds a tag and lists it', async (s) => {
    const id = crypto.randomUUID();
    await s.stores.directory.addTag({ id, name: 'urgent' }, s.stamp);
    expect((await s.stores.directory.listTags()).map((each) => each.name)).toContain('urgent');
  });

  offered(
    kit,
    'directory.assign:unknown_person',
    'refuses an assignee the directory does not hold, and writes nothing',
    async (s) => {
      const workItemId = await aWorkItem(s);
      const assigned = await s.stores.directory.assign(
        workItemId,
        s.stepId,
        'nobody-by-that-id',
        s.stamp,
      );
      expect(assigned).toEqual({ ok: false, reason: 'unknown_person' });
      expect(await s.stores.directory.assignmentsFor(workItemId)).toEqual([]);
    },
  );
}

/** The event log's contract: the sequence, the range, and what pruning leaves. */
function eventLogStoreConformance(kit: Kit): void {
  offered(kit, 'eventLog.recordEvent', 'numbers a subscription from zero, in order', async (s) => {
    const subscription = `project:${s.projectId}`;
    expect(await s.stores.eventLog.latestSeq(subscription)).toBe(-1);
    const first = await s.stores.eventLog.recordEvent(subscription, { type: 'first' }, 1);
    const second = await s.stores.eventLog.recordEvent(subscription, { type: 'second' }, 2);
    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(await s.stores.eventLog.latestSeq(subscription)).toBe(1);
  });

  offered(kit, 'eventLog.rangeSince', 'answers what a resuming reader has not seen', async (s) => {
    const subscription = `project:${s.projectId}`;
    await s.stores.eventLog.recordEvent(subscription, { type: 'first' }, 1);
    await s.stores.eventLog.recordEvent(subscription, { type: 'second' }, 2);
    const since = await s.stores.eventLog.rangeSince(subscription, 0);
    expect(since.map((each) => each.seq)).toEqual([1]);
  });

  offered(
    kit,
    'eventLog.pruneBeyond',
    'keeps the newest events and never moves the sequence back',
    async (s) => {
      const subscription = `project:${s.projectId}`;
      for (let n = 0; n < 4; n += 1) {
        await s.stores.eventLog.recordEvent(subscription, { type: `e${String(n)}` }, n);
      }
      expect(await s.stores.eventLog.pruneBeyond(2)).toBe(2);
      // The sequence is the sequencer's, not `MAX(seq)` of what is left: a
      // client resuming from a pruned number must not be told it is up to date.
      expect(await s.stores.eventLog.latestSeq(subscription)).toBe(3);
      expect((await s.stores.eventLog.rangeSince(subscription, -1)).map((e) => e.seq)).toEqual([
        2, 3,
      ]);
    },
  );
}

/** A work item to hang a write off, written through the store under test. */
async function aWorkItem(source: SourceUnderTest): Promise<string> {
  const id = crypto.randomUUID();
  await source.stores.workItems.insert(
    workItemRow({ id, projectId: source.projectId, name: 'Strip' }),
    [],
    source.stamp,
  );
  return id;
}

/**
 * Every kit a source's transactional ports have, as one composition, with a
 * report naming what ran and what was not offered.
 *
 * The composition **is** the certification: a source is certified for the ports
 * it has and is not asked about the rest, and the report is how a reader tells
 * the two apart (D22, D29). A case that is skipped is printed as skipped by
 * `bun:test` and carried out in the report; nothing is quietly not run.
 */
export function sourceConformance(
  source: SourceDeclaration,
  open: () => SourceUnderTest,
): ConformanceReport {
  const declared = source.notOffered ?? [];
  const report: ConformanceReport = {
    ran: [],
    skipped: [],
    unknownAllowlistEntries: () => {
      const known = new Set([...report.ran, ...report.skipped]);
      return declared.filter((id) => !known.has(id));
    },
  };
  const kit: Kit = { open, report, declared };
  describe(`${source.name}: the step store`, () => {
    stepStoreConformance(kit);
  });
  describe(`${source.name}: the estimate store`, () => {
    estimateStoreConformance(kit);
  });
  describe(`${source.name}: the directory store`, () => {
    directoryStoreConformance(kit);
  });
  describe(`${source.name}: the event log`, () => {
    eventLogStoreConformance(kit);
  });
  const offeredCases = SOURCE_CONFORMANCE_CASES.filter((id) => !declared.includes(id));
  const notOfferedCases = SOURCE_CONFORMANCE_CASES.filter((id) => declared.includes(id));
  it(`${source.name} report — ran: ${offeredCases.join(', ')}; not offered: ${notOfferedCases.join(', ') || 'none'}`, () => {
    certifySourceReport(source.name, report);
  });
  return report;
}
