import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CORPUS_BOUNDARY_EVENTS } from './corpus-version-base';

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
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
 * whole suite would pass by checking nothing. Take whichever key is really
 * there and assert the lookup found one.
 */
const triggersOf = (workflow: Workflow): string[] => {
  const record = workflow as unknown as Record<string, unknown>;
  // Bracketed because both come from an index signature (TS4111), not style.
  const block = (record['on'] ?? record['true']) as Record<string, unknown> | undefined;
  expect(block, 'the workflow has no `on:` block under either key').toBeDefined();
  return Object.keys(block ?? {});
};

const corpusLintStep = (workflow: Workflow): WorkflowStep => {
  const step = workflow.jobs?.gate?.steps?.find(({ name }) => name === 'Corpus version lint');
  expect(step, 'the gate job has no `Corpus version lint` step').toBeDefined();
  return step ?? {};
};

describe('the CI corpus-version-lint boundary', () => {
  test('subscribes to exactly the events the production selector supports', () => {
    // Proof: removed `merge_group:` from the workflow. This failed with the
    // subscribed set missing `merge_group`; the earlier inline-arm companion
    // also failed, 2 failed / 2 passed, watched 2026-09-08. The selector now
    // owns the supported set, so moving either side alone remains visible.
    const subscribed = triggersOf(readWorkflow()).sort();
    const supported = [...CORPUS_BOUNDARY_EVENTS].sort();

    expect(subscribed).toEqual(supported);
    expect(supported.length).toBeGreaterThan(0);
  });

  test('runs the production selector before the corpus comparator', () => {
    // Proof: replaced the production selector invocation with `base="HEAD"`.
    // This failed on the missing selector command; 3 passed / 1 failed,
    // watched 2026-09-08.
    const script = corpusLintStep(readWorkflow()).run;

    expect(script, 'the corpus step has no script').toBeDefined();
    expect(script).toContain(
      'base="$(bun run tools/tool-git-hooks/src/hooks/corpus-version-base.ts)"',
    );
    expect(script).toContain(
      'bun run tools/tool-git-hooks/src/hooks/corpus-version-lint.ts "$base" HEAD',
    );
    expect(script?.indexOf('corpus-version-base.ts')).toBeLessThan(
      script?.indexOf('corpus-version-lint.ts') ?? -1,
    );
  });

  test('passes each immutable payload boundary without a mutable PR ref', () => {
    // Proof: passed the mutable `${{ github.base_ref }}` as `PR_BASE_SHA`.
    // This failed on the exact environment object; 3 passed / 1 failed,
    // watched 2026-09-08.
    const environment = corpusLintStep(readWorkflow()).env;

    expect(environment).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      PUSH_BEFORE: '${{ github.event.before }}',
      MERGE_GROUP_BASE_SHA: '${{ github.event.merge_group.base_sha }}',
      DISPATCH_BASE_REF: '${{ inputs.base_ref }}',
    });
    expect(environment).not.toHaveProperty('PR_BASE_REF');
  });

  test('never cancels a merge-queue run, for the reason it never cancels main', () => {
    // Proof: returned this expression to its pre-merge-group form,
    // `github.ref != 'refs/heads/main'`. Only this case failed, watched on
    // h2puni 2026-09-08.
    expect(readWorkflow().concurrency?.['cancel-in-progress']).toBe(
      "${{ github.ref != 'refs/heads/main' && github.event_name != 'merge_group' }}",
    );
  });

  test('keys main per run, because one commit is entered by more than one run', () => {
    // TASK-386, then TASK-395. `cancel-in-progress: false` governs the RUNNING
    // member of a group; GitHub holds at most one PENDING member beside it and
    // evicts that one when a third run enters. Measured on `main` 2026-09-08:
    // f64ceea4, 564af749, be5eedc5 and 6ddba437 all `cancelled` with zero jobs
    // while 5bb095a5 held the group.
    //
    // TASK-386 keyed by `github.sha`, which is one group per COMMIT and not per
    // RUN. `GITHUB_SHA` for `workflow_dispatch` is the tip of the selected ref,
    // so a manual dispatch against main at commit S joins S's push run and any
    // re-run of it; a force-push back to S collides the same way. Those runs
    // are NOT interchangeable — `Corpus version lint` reads DISPATCH_BASE_REF
    // on a dispatch and PUSH_BEFORE on a push, so they check different
    // boundaries and the evicted member is a verdict nothing else produces.
    // They are therefore separated rather than deduplicated.
    //
    // `github.run_id` is ADDED, not substituted for the sha. Keying on run_id
    // alone would be the same key by behaviour, but its failure mode is worse:
    // an empty render there collapses main into the single shared group and
    // silently reopens TASK-386, while here it degrades only to TASK-386's own
    // per-commit key. The sha also keeps the group legible in the Actions UI.
    //
    // Proof, watched on h2puni 2026-09-08: returned `group` to its pre-fix
    // `ci-${{ github.ref }}` and only this case failed; then set it to
    // `ci-${{ github.ref }}-${{ github.sha }}` UNCONDITIONALLY — the over-fix
    // that would stop pull-request runs superseding each other — and only this
    // case failed again. Both mutants move this one assertion rather than two
    // different ones, which is the point of asserting a whole string: a
    // `toContain('github.sha')` would have passed the second, and a
    // `toContain('github.run_id')` would pass a key that dropped the sha.
    //
    // That `github.run_id` renders non-empty and per-run distinct in the
    // WORKFLOW-level concurrency context is behaviour, not assumption: one
    // commit pushed to `probe/t395-a|b|c` at 2026-09-08T02:54:49Z reached three
    // concurrent verdicts under this key while TASK-386's key, fed the very
    // same three pushes, evicted the middle entrant. An echo inside a job would
    // have proved only the job context.
    //
    // Rendering both arms in a real run (`probe/t386-expr`, 2026-09-08T01:46Z)
    // gave `ci-refs/heads/…-<sha>` matched and `ci-refs/heads/…` unmatched — no
    // stray `false`, no trailing dash — which is why the `|| ''` is safe to
    // leave implicit here.
    expect(readWorkflow().concurrency?.group).toBe(
      "ci-${{ github.ref }}${{ github.ref == 'refs/heads/main' && format('-{0}-{1}', github.sha, github.run_id) || '' }}",
    );
  });
});
