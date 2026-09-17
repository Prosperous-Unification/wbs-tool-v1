import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

interface WorkflowStep {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: { name?: string; path?: string };
}

interface WorkflowJob {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { shard?: number[] } };
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
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

describe('the CI pixels gate', () => {
  test('runs every browser shard and makes the stable pixels check depend on them', () => {
    const workflow = readWorkflow();
    const shardJob = workflow.jobs?.['pixels_shard'];
    const summaryJob = workflow.jobs?.['pixels'];
    const layoutStep = shardJob?.steps?.find(({ name }) => name === 'Layout gate');
    const artifactStep = shardJob?.steps?.find(({ uses }) =>
      uses?.startsWith('actions/upload-artifact@'),
    );

    expect(shardJob?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(shardJob?.name).toBe('pixels shard ${{ matrix.shard }}/4');
    expect(layoutStep?.run).toBe('bun run e2e -- --shard=${{ matrix.shard }}/4');
    expect(artifactStep?.with?.name).toBe(
      'wbs-table-screenshot-${{ matrix.shard }}-${{ github.run_attempt }}',
    );
    // Proof: restoring only the first upload root to `apps/fe-01/test-results/`
    // failed this production-workflow oracle with the complete legacy path (2026-09-14).
    expect(artifactStep?.with?.path).toBe(
      'apps/wbs/fe-01/test-results/\napps/wbs/fe-01/playwright-report/\n',
    );
    expect(summaryJob?.needs).toEqual(['pixels_mode', 'pixels_shard']);
    expect(summaryJob?.if).toBe('${{ always() }}');
  });
});

/**
 * `on` is the one key YAML 1.1 reads as a boolean, so `workflow.on` is undefined and a
 * suite that read it would pass by checking nothing — see `corpus-lint-workflow.test.ts`.
 */
const subscribedEvents = (workflow: Workflow): string[] => {
  const record = workflow as unknown as Record<string, unknown>;
  // Bracketed because both come from an index signature (TS4111), not style.
  const block = (record['on'] ?? record['true']) as Record<string, unknown> | undefined;
  expect(block, 'the workflow has no `on:` block under either key').toBeDefined();
  return Object.keys(block ?? {});
};

/**
 * The event labels of the OUTER `case` in a script, `*` included, one per alternative.
 *
 * The class deliberately excludes the space that used to be in it. With ` ` inside,
 * `^ {2}` consumed two spaces of a SIX-space nested arm and the class ate the other four,
 * so the inner `case "$stack_status"`'s own `*)` was harvested as an outer event: the real
 * script yielded `["pull_request", "*", "push", "merge_group", "workflow_dispatch", "*"]`
 * and `toContain('*')` passed with the outer refusal arm deleted. Alternatives are matched
 * as an explicit ` | ` list instead, which only the outer arms are written as.
 */
const caseArmEvents = (script: string): string[] =>
  [...script.matchAll(/^ {2}([a-z_]+(?: \| [a-z_]+)*|\*)\)$/gm)].flatMap((match) =>
    match[1].split('|').map((event) => event.trim()),
  );

/**
 * A shell script with its WHOLE-LINE comments dropped — a line whose first non-space
 * character is `#`. A trailing comment on a command line survives, so the guarantee this
 * gives is exactly "a standalone comment cannot satisfy a pin", not "no comment can".
 *
 * Not tidiness: a `Proof:` comment beside a pinned arm quotes the literal the pin asserts,
 * so a pin that reads comments can be satisfied by the note ABOUT it. Watched on
 * 2026-09-16 — reflowing that comment onto one line and deleting the arm's own `exit 1`
 * left all six cases in this file green. The note now lives outside the `run:` block as
 * well, but stripping here is what makes the pin independent of where anyone puts it.
 */
const commandsOf = (script: string): string =>
  script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

/**
 * A script with every run of whitespace collapsed to one space.
 *
 * A refusal is two lines — say what happened, then stop — and a `toContain` on either line
 * alone pins neither. `exit 1` in particular appears more than once in these scripts now,
 * so asserting it bare is an assertion that cannot fail; asserting the pair as one
 * normalised string is what makes deleting the `exit` visible.
 */
const oneLine = (script: string): string => script.replace(/\s+/g, ' ');

const jobStep = (workflow: Workflow, job: string, name: string): WorkflowStep => {
  const step = workflow.jobs?.[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step, `job \`${job}\` has no \`${name}\` step`).toBeDefined();
  return step ?? {};
};

/**
 * The browser gate's scope, which follows the Nx gate's switch without going vacuous.
 *
 * The shards are the slowest and flakiest thing in this workflow, and they are also the
 * only check that lays the table out, so narrowing them is the change most able to do
 * quiet damage. Two things keep it honest: the boot set comes from
 * `playwright.config.ts` rather than from the job's name, and `pixels` — the check the
 * ruleset requires — accepts a skip only when the scope job said the stack is
 * unaffected, so a scope job that failed can never read as a pass.
 */
describe('the CI pixels scope', () => {
  test('decides the browser scope from the event, and refuses one it has no rule for', () => {
    // Proofs re-observed 2026-09-16 on the shipped tree, because the first pair of them was
    // written before the nested `case "$stack_status"` existed and stopped reproducing when
    // it landed — see `caseArmEvents` above:
    //
    // 1. Whole `*)` arm deleted from `Browser stack scope`: fails on the star assertion
    //    below with `Expected: ["*"] · Received: []` — 5 passed / 1 failed. It could not
    //    fail before: the old extractor harvested the nested `case "$stack_status"`'s `*)`
    //    too, so `arms` was `["pull_request", "*", "push", "merge_group",
    //    "workflow_dispatch", "*"]` and a `toContain('*')` passed with this arm gone.
    // 2. Only the arm's `exit 1` deleted, leaving the message — the log-and-continue shape
    //    AGENTS.md forbids: fails on `Expected to contain: "printf 'no browser-stack rule
    //    for event %s\\n' \"$EVENT_NAME\" >&2 exit 1"` — 5 passed / 1 failed. Before this
    //    fix that fault left all SIX cases green, because the `type == "array"` guard in the
    //    same script supplies a second `exit 1` for a bare `toContain('exit 1')` to find.
    const workflow = readWorkflow();
    const script = jobStep(workflow, 'pixels_mode', 'Browser stack scope').run ?? '';

    // Exactly one `*`, and exactly the subscribed events beside it. `toContain('*')` alone
    // passed while a nested arm supplied the star. Sorted rather than positional, because
    // the `on:` block's key order is not the arm order and neither is a contract.
    const arms = caseArmEvents(script);
    expect(arms.filter((event) => event === '*')).toEqual(['*']);
    expect(arms.filter((event) => event !== '*').sort()).toEqual(subscribedEvents(workflow).sort());
    expect(oneLine(commandsOf(script))).toContain(
      `printf 'no browser-stack rule for event %s\\n' "$EVENT_NAME" >&2 exit 1`,
    );
  });

  test('asks Nx about every app the browser stack boots, as JSON', () => {
    // Proof (2026-09-16): `bunx nx show projects --affected --files=apps/wbs/be-01/src/main.ts`
    // answers `["wbs-be-01","tool-devsync","wiki-cli","tool-dagger"]` on Nx 23.2.0 — no
    // `wbs-fe-01`. Re-measured on this tree after W6 renamed the project; W3 measured the
    // same list with `tool-wiki` in it. With the production membership narrowed to a single
    // project, this failed on the missing three-project expression — 1 failed / 4 passed.
    // That is the backend
    // change which breaks the rendered table while the frontend project is untouched.
    // (The fault was watched before `-s` landed, so the expectation it printed then named
    // the unslurped form; the assertion below is the current text, which is what the pin
    // holds today.)
    const step = jobStep(readWorkflow(), 'pixels_mode', 'Browser stack scope');

    expect(step.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    });
    // Through `commandsOf`, like its tool-devsync twins. No comment beside this step quotes
    // these literals today; the point is that none ever can. A `Proof:` note naturally
    // quotes the thing it is about, and one written here later must not be able to satisfy
    // the pin it explains.
    const commands = commandsOf(step.run ?? '');
    expect(commands).toContain(
      'bunx nx show projects --affected --base="$PR_BASE_SHA" --head=HEAD --json',
    );
    // One expression naming all three, so narrowing the set moves this assertion. `grep`
    // cannot be used here: `nx show projects` prints a one-line JSON array on a non-TTY.
    expect(commands).toContain(
      `jq -s -e 'any(.[0][]; . == "wbs-fe-01" or . == "wbs-be-01" or . == "wbs-gw-01")'`,
    );
    expect(commands).not.toContain('grep');
    expect(readWorkflow().jobs?.['pixels_mode']?.outputs).toEqual({
      stack: '${{ steps.stack.outputs.stack }}',
    });
  });

  test('refuses a jq failure instead of reading it as the stack being unaffected', () => {
    // Same fault as the gate's Tool Wiki switch, with a worse blast radius: `if jq -e … then
    // affected; else unaffected; fi` treats jq's 2-or-more (parse error on polluted stdout, a
    // type error) exactly like its `false`, so a broken read sets `stack=unaffected`, all four
    // shards skip, and the REQUIRED `pixels` check goes green having booted no browser at all.
    //
    // Proof (2026-09-16): with the production switch returned to its two-branch form, this
    // failed on the missing array guard — 5 passed / 1 failed. Behaviourally, the two-branch
    // form fed a non-array printed `unaffected` and exited 0; this one refuses naming the
    // output. The `*)` arm guards jq itself failing rather than any input shape — see the
    // companion proof in `toolchain-pins.test.ts`, where a `jq` stub that breaks on the
    // second call was watched reaching it.
    //
    // `-s` and `length == 1` are the other half, and they were watched through THIS step's
    // extracted script: with a `bunx` stub printing a warning document ahead of the array,
    // the unslurped form exited 0 and wrote a `stack=` decision from a partially errored
    // read, while this one printed `nx show projects did not return one JSON array: …` and
    // exited 1. Without `-s`, jq judges only the LAST document it is given.
    const script = commandsOf(
      jobStep(readWorkflow(), 'pixels_mode', 'Browser stack scope').run ?? '',
    );

    expect(script).toContain(`jq -s -e 'length == 1 and (.[0] | type == "array")'`);
    expect(script).toContain('stack_status=0');
    expect(script).toContain('|| stack_status=$?');
    expect(script).toContain('exit "$stack_status"');
    expect(script.indexOf(`jq -s -e 'length == 1 and (.[0] | type == "array")'`)).toBeLessThan(
      script.indexOf('any(.[0][]; . == "wbs-fe-01"'),
    );
  });

  test('runs the shards only when the browser stack is in scope', () => {
    const shardJob = readWorkflow().jobs?.['pixels_shard'];

    expect(shardJob?.needs).toBe('pixels_mode');
    expect(shardJob?.if).toBe("${{ needs.pixels_mode.outputs.stack == 'affected' }}");
  });

  test('the required check refuses a skip it cannot explain', () => {
    // Proof (2026-09-16): with the aggregate reduced to its previous
    // `test "${{ needs.pixels_shard.result }}" = success`, this failed on the exact
    // environment — expected the three `needs` values, received `undefined` — 1 failed /
    // 4 passed. That one-liner fails the required check on a legitimate skip, and the
    // obvious relaxation of it (accepting `skipped` too) would pass a `pixels_shard`
    // that was skipped because `pixels_mode` FAILED.
    const summary = jobStep(readWorkflow(), 'pixels', 'Require every browser shard');

    expect(summary.env).toEqual({
      STACK: '${{ needs.pixels_mode.outputs.stack }}',
      STACK_RESULT: '${{ needs.pixels_mode.result }}',
      SHARD_RESULT: '${{ needs.pixels_shard.result }}',
    });
    // `set -euo pipefail` is what makes the first `test` a REFUSAL rather than a line whose
    // status is discarded. Without it the script runs on to the `case` and the aggregate
    // reports on the shards alone, which is the hole this whole step exists to close — so it
    // is pinned here rather than assumed, and pinned FIRST because everything below depends
    // on it.
    expect(summary.run?.startsWith('set -euo pipefail\n')).toBe(true);
    // The scope job's own verdict first: a skip is only ever read as a pass when the job
    // that decided to skip actually succeeded.
    const aggregate = commandsOf(summary.run ?? '');
    expect(aggregate).toContain('test "$STACK_RESULT" = success');
    expect(aggregate).toContain('test "$SHARD_RESULT" = success');
    expect(aggregate).toContain('test "$SHARD_RESULT" = skipped');
    expect(caseArmEvents(summary.run ?? '')).toContain('*');
  });
});
