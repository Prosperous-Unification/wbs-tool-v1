import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * The comparator in `corpus-version-lint.ts` is unit-tested next door. What is
 * NOT unit-testable is the half that decides WHICH TWO COMMITS it compares:
 * that lives as shell inside `.github/workflows/ci.yml`, and every finding this
 * file exists for was about that half rather than about the comparison.
 *
 * TASK-351 I2 is the shape worth a standing check, because it is a coupling and
 * not a value. The step's `case` ends in `*) exit 1`, so an event the workflow
 * subscribes to WITHOUT a matching arm turns every run of that event red, and
 * an arm without a subscription is dead code that reads as coverage. The two
 * sides are edited in different parts of one long file, roughly 250 lines
 * apart, which is exactly far enough to move one and forget the other.
 *
 * These assertions read the real workflow, and each was made to fail on the real
 * fault before this file was committed — 2026-09-08 on h2puni, mutating a copy
 * of `ci.yml` one edit at a time and restoring between runs. Unmutated: 4 pass,
 * 14 expect() calls. Then:
 *   - `merge_group:` removed from `on:` → 2 fail. The subscription test prints
 *     `Received: [ "push", "pull_request", "workflow_dispatch" ]`, and the
 *     coupling test reports `boundary arms for no subscribed event` — the arm
 *     had become unreachable code that still read as coverage.
 *   - the `merge_group)` arm deleted from the step → 2 fail: `subscribed events
 *     with no boundary arm`, which is the every-queue-entry-red state, plus the
 *     empty-slice guard in the boundary test.
 *   - `cancel-in-progress` returned to exactly its pre-fix `github.ref !=
 *     'refs/heads/main'` → 1 fail, and only that one.
 * Each control moves a different assertion, which is what distinguishes them
 * from four restatements of one fact.
 */

interface WorkflowStep {
  name?: string;
  run?: string;
}

/**
 * `jobs` names `gate` rather than being a `Record`, because an index signature
 * types every lookup as present and `no-unnecessary-condition` then rejects the
 * `?.` that a missing job actually needs. `on` is absent here on purpose — see
 * {@link triggersOf}.
 */
interface Workflow {
  concurrency?: { group?: string; 'cancel-in-progress'?: string };
  jobs?: { gate?: { steps?: WorkflowStep[] } };
}

const workflowPath = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'ci.yml',
);

const readWorkflow = (): Workflow => Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as Workflow;

/**
 * `on` is the one key YAML 1.1 turns into a boolean, and Bun.YAML follows the
 * spec that does it. Reading `workflow.on` therefore returns undefined and the
 * whole suite would pass by checking nothing — the vacuous-green shape AGENTS.md
 * names. Take whichever key is really there and assert the lookup found one.
 */
const triggersOf = (workflow: Workflow): string[] => {
  const record = workflow as unknown as Record<string, unknown>;
  // Bracketed because both come from an index signature (TS4111), not style.
  const block = (record['on'] ?? record['true']) as Record<string, unknown> | undefined;
  expect(block, 'the workflow has no `on:` block under either key').toBeDefined();
  return Object.keys(block ?? {});
};

const corpusLintScript = (workflow: Workflow): string => {
  const step = workflow.jobs?.gate?.steps?.find(({ name }) => name === 'Corpus version lint');
  expect(step?.run, 'the gate job has no `Corpus version lint` step').toBeDefined();
  return step?.run ?? '';
};

/**
 * The `case` labels the step actually branches on, e.g. `pull_request)`. The
 * indentation is left free rather than pinned to a count: YAML strips the block
 * scalar's own indent on parse, so a pinned count encodes how deep the step sits
 * in the file and would go vacuously green — matching nothing — if the step were
 * ever re-nested. `*)` cannot match `[a-z_]+`, which is what keeps the catch-all
 * out of the set.
 */
const boundaryArms = (script: string): string[] =>
  [...script.matchAll(/^[ \t]*([a-z_]+)\)$/gm)].map((match) => match[1]);

describe('the CI corpus-version-lint boundary', () => {
  test('subscribes to merge_group, so a merge queue cannot silently drop the gate', () => {
    // The literal finding: with a queue enabled and no subscription, the check
    // is not "skipped" in the queue's required checks — it is absent.
    expect(triggersOf(readWorkflow())).toContain('merge_group');
  });

  test('gives every subscribed event a boundary arm, and every arm an event', () => {
    const workflow = readWorkflow();
    const arms = boundaryArms(corpusLintScript(workflow));
    // `push` is subscribed as `push: branches: [main]`; the arm is named for the
    // event, so the two sets compare directly.
    const triggers = triggersOf(workflow);

    const subscribedWithoutArm = triggers.filter((event) => !arms.includes(event));
    const armWithoutSubscription = arms.filter((event) => !triggers.includes(event));

    // Named rather than counted: a bare `toEqual([])` on a mismatch prints the
    // event, which is the only fact the next reader needs.
    expect(subscribedWithoutArm, 'subscribed events with no boundary arm').toEqual([]);
    expect(armWithoutSubscription, 'boundary arms for no subscribed event').toEqual([]);
    // And the sets are non-empty, so a regex that stopped matching reads as red.
    expect(arms.length).toBeGreaterThan(0);
  });

  test('takes the merge group boundary from the immutable base_sha, not origin/main', () => {
    const script = corpusLintScript(readWorkflow());
    // Bounded by the arm's own `;;`, not by the arm that happens to follow it:
    // slicing to `workflow_dispatch)` would silently return an EMPTY string —
    // and pass three `toContain`s vacuously — the day the arms are reordered.
    const start = script.search(/^[ \t]*merge_group\)$/m);
    const end = script.indexOf(';;', start);
    expect(start, 'no `merge_group)` case label in the step').toBeGreaterThanOrEqual(0);
    expect(end, 'the `merge_group)` arm is not terminated by `;;`').toBeGreaterThan(start);
    const arm = script.slice(start, end);

    expect(arm).toContain('$MERGE_GROUP_BASE_SHA');
    // The task's own failure mode: with another entry queued ahead, `main` is
    // behind the group base and that entry's fixture edits land on this change.
    expect(arm).not.toContain('origin/main');
    // Fails closed, and terminates option parsing (I4's rule applies here too).
    expect(arm).toContain('exit 1');
    expect(arm).toContain('git merge-base -- "$MERGE_GROUP_BASE_SHA" HEAD');
  });

  test('never cancels a merge-queue run, for the reason it never cancels main', () => {
    // A queue ref is `refs/heads/gh-readonly-queue/…`, which is `!= main`, so
    // the ref test alone answered "cancellable" for the one verdict that cannot
    // be reproduced by pushing the branch again.
    expect(readWorkflow().concurrency?.['cancel-in-progress']).toBe(
      "${{ github.ref != 'refs/heads/main' && github.event_name != 'merge_group' }}",
    );
  });
});
