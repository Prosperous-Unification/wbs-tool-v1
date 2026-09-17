import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import type { DependencyEdge, Slice } from './schedule';
import { schedule } from './schedule';

/**
 * A plan the size of a real one: 20 parents of 10 work items, three steps each.
 *
 * 600 slices and 60-odd dependencies — some declared between parents, which
 * expand to every pair of leaves beneath them — with eight people carrying the
 * work and one person often covering a whole work item. The point of the
 * fixture is that leveling **binds** in it: a benchmark over a plan nobody is
 * assigned to would time the pass that already existed.
 *
 * The 20 were called *phases* until `steps-not-phases`, where the word became
 * the project's own spelling of what a slice is under. They are top-level work
 * items and never were a step, so they are `parent` here rather than collapsing
 * into the inner loop's name — which is exactly what a blind rename did. The
 * inner `stepIds.forEach((stepId, step) => …)` shadows both, and the fixture's
 * own arithmetic moves with them.
 *
 * Proof: `parent` and `parentId` renamed to `step` and `stepId` throughout this
 * function, so the shadowing is back. `is the plan it claims to be` failed on
 * `expect(received).toBe(expected)` · `Expected: 188  Received: 190`; watched
 * 2026-08-30, re-measured against `assumed-duration-schedules`' figure. It read
 * 175 against 173 when the fault was first found.
 */
function buildPlan(): { rows: PlannedRow[]; edges: DependencyEdge[]; slices: Slice[] } {
  const stepIds = ['step-dev', 'step-qa', 'step-doc'];
  const people = Array.from({ length: 8 }, (_, i) => `person-${String(i)}`);
  const rows: PlannedRow[] = [];
  const slices: Slice[] = [];
  const edges: DependencyEdge[] = [];
  const newRow = (id: string, parentId: string | null, position: number): PlannedRow => ({
    id,
    parentId,
    position,
    frozenNumber: null,
    priority: null,
  });

  for (let parent = 0; parent < 20; parent += 1) {
    const parentId = `parent-${String(parent)}`;
    rows.push(newRow(parentId, null, parent * 10));
    // Every fourth parent waits for the one before it — a plan whose parents all
    // ran in a single chain would have nobody free to queue behind anybody.
    if (parent % 4 === 0 && parent > 0) {
      edges.push({ predecessorId: `parent-${String(parent - 1)}`, successorId: parentId });
    }
    for (let at = 0; at < 10; at += 1) {
      const leafId = `${parentId}-${String(at)}`;
      rows.push(newRow(leafId, parentId, at * 10));
      // Somebody is on most of it, and one work item's steps are often one
      // person's — which is the assumed assignee, and the queue that binds.
      const owner = people[(parent + (at % 3)) % people.length];
      const covered = at % 3 === 0;
      stepIds.forEach((stepId, step) => {
        slices.push({
          workItemId: leafId,
          stepId,
          days: (at + step) % 7 === 0 ? null : 1 + ((parent + at + step) % 4) / 3,
          personId: covered ? owner : step === 0 ? owner : null,
          // No capacity in this fixture: the budget below is about the graph
          // and the queues, and a pool would make it about a second thing.
          width: 1,
          poolIds: [],
        });
      });
      // A chain inside the parent, and one edge reaching back two parents.
      if (at % 5 === 1) {
        edges.push({ predecessorId: `${parentId}-${String(at - 1)}`, successorId: leafId });
      }
      if (parent > 1 && at === 5) {
        edges.push({ predecessorId: `parent-${String(parent - 2)}-3`, successorId: leafId });
      }
    }
  }
  return { rows, edges, slices };
}

/** Whole milliseconds are too coarse for a 20ms budget; `Bun.nanoseconds` is not. */
const millisecondsFor = (run: () => void): number => {
  const started = Bun.nanoseconds();
  run();
  return (Bun.nanoseconds() - started) / 1e6;
};

describe('the leveled pass, at the size of a real plan', () => {
  const plan = buildPlan();

  it('is the plan it claims to be, so the budget below measures something', () => {
    // A benchmark over a fixture that turned out to be ten rows and no people
    // would pass for ever and mean nothing.
    expect(plan.rows).toHaveLength(220);
    expect(plan.slices).toHaveLength(600);
    expect(plan.edges.length).toBeGreaterThan(50);

    const found = schedule(plan.rows, plan.edges, plan.slices);
    expect(found.slices.size).toBe(600);
    // Leveling binds here: without that this measures the pass that already
    // existed rather than the one this change added.
    // The exact figure, so a fixture that quietly stops queueing is visible:
    // 177 of the 200 work items wait for the person on them, on the default
    // `whole-item` reach. The `anchor-slice` figure is asserted beside it
    // rather than described, because two rules have moved this number and one
    // figure could no longer say which:
    //
    // - 159 — whole-item waits, unestimated slices of no length (before 2026-08-11)
    // - 175 — `dep-waits-on-first-role`: anchor waits release successors
    //   earlier, so more slices contend for the same people at once
    // - 188 — `assumed-duration-schedules`: one slice in seven here is
    //   unestimated, those slices are on somebody, and a slice with a width
    //   occupies its assignee where a slice of no length did not
    // - 177 — `dep-reach-whole-item`'s default, which takes the waits back to
    //   the whole work item while keeping the assumed widths
    //
    // 188 is `main`'s own figure for this fixture, and the `anchor-slice` arm
    // reproducing it exactly is the cross-check that this change moved the
    // **reach** and nothing else.
    expect(found.waitingForPerson).toBe(177);
    expect(
      schedule(plan.rows, plan.edges, plan.slices, undefined, undefined, 'anchor-slice')
        .waitingForPerson,
    ).toBe(188);
  });

  it('schedules 600 slices in under 20ms', () => {
    // The best of five runs after a warm one: the pass is deterministic, so the
    // spread is the machine's — a shared CI runner descheduling mid-measurement
    // is not a regression in the algorithm, and a flaky gate is a gate people
    // learn to ignore.
    //
    // 20ms is CI's number, re-derived 2026-08-21 from the runners rather than
    // from a laptop. The five figures below are printed on every run, so 66
    // `gate` jobs between 2026-08-16 and 2026-08-21 carry their own
    // measurement of the same code: the best-of-five is log-normal about a
    // 3.81ms geometric mean with sigma(log) 0.337 — p99 8.3ms, p99.9 10.8ms,
    // p99.99 13.3ms, worst actually observed 12.16ms (run 32360096281,
    // `main@1d7751f`, 2026-08-20). The old 10ms sat INSIDE that spread, near
    // its own p99.9, so the gate was asserting the runner's mood; it went red
    // once in 66 and would have kept doing it. 20ms is 1.5x the modelled
    // p99.99 and 1.6x the worst run ever seen here.
    //
    // Not a regression, and that was established before the number was moved:
    // per-day medians across those six days read 3.09, 3.20, 4.03, 3.76, 3.78,
    // 3.30ms — flat through tags (#87), the mismatch signals (#90) and the
    // service split, none of which touch `schedule.ts`. The red run's own
    // neighbours on near-identical code read 5.71ms eleven minutes before it
    // and 4.09ms nine hours after.
    //
    // Still best-of-five and not more, deliberately: in the red run ALL FIVE
    // samples were 12.2-19.4ms, so the runner was slow for the whole ~80ms
    // window. Spread inside one burst is the machine's state, not per-sample
    // jitter, and sampling harder buys nothing against it — only a budget
    // outside the noise does.
    //
    // Proof that this is a measurement rather than a number nobody checks: with
    // the fixture at eight times the size — 1,760 rows, 4,800 slices — the same
    // assertion read 13.6ms and failed, and with the eligible set scanned
    // linearly instead of held in a heap it read 26.7ms; watched 2026-08-09 on
    // a machine where the pass measures 1.5ms. Scaled to CI's 3.81ms nominal,
    // those regressions land at ~35ms and ~68ms, so 20ms still catches the
    // cheaper of the two with 1.7x to spare. It measures 1.5ms here, and did
    // 2.9ms before the passes were moved off maps and onto node indices.
    schedule(plan.rows, plan.edges, plan.slices);
    const runs = Array.from({ length: 5 }, () =>
      millisecondsFor(() => {
        schedule(plan.rows, plan.edges, plan.slices);
      }),
    );

    console.log(JSON.stringify(runs));
    expect(Math.min(...runs)).toBeLessThan(20);
  });
});
