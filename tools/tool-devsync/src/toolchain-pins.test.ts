import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'bun:test';

/**
 * The version pins that can drift apart, held together by a test.
 *
 * Bun's version used to be typed in six places — the CI workflow twice, three
 * app Dockerfiles and the dev-src Dockerfile — and on 2026-09-06 they said
 * three different things: 1.3.14, 1.3.14 and 1.2.20, against a 1.4.0 on the
 * workspace box. Nothing read them side by side, so nothing could say so.
 * `.bun-version` is now the one source: `setup-bun` reads it through
 * `bun-version-file`, and the Dockerfiles, which cannot read a file, are held
 * to it here.
 *
 * Every file this suite reads from outside its own project is named in
 * `tool-devsync:test`'s `inputs`, and that is not bookkeeping: Nx caches the
 * target, and a read it does not know about is a change it cannot see.
 * Measured 2026-09-06: with `{workspaceRoot}/apps/*\/Dockerfile` declared, a
 * Dockerfile put back to 1.3.14 re-ran this suite and failed it; with that
 * line removed, the same edit answered `nx run tool-devsync:test [local
 * cache]` — green, having run nothing. `workspace-targets.test.ts` cannot see
 * these reads (it looks for `'../../../…'` literals), so the list is kept by hand.
 *
 * Proof: with `apps/wbs/be-01/Dockerfile`'s first stage put back to
 * `oven/bun:1.3.14-alpine`, `every Bun image tag equals .bun-version` failed
 * on `- []` / `+ [ "apps/wbs/be-01/Dockerfile: 1.3.14" ]` (2026-09-06). And with
 * `bun-version: 1.3.14` put back in place of `bun-version-file` in the
 * `pixels` job, `CI reads the file rather than a literal` failed on
 * `Expected: 0 · Received: 1`.
 */
const WORKSPACE = new URL('../../../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, WORKSPACE), 'utf8');
}

/** Every Dockerfile that starts from a Bun image. Listed, so a new one is added here on the day it is written. */
const BUN_DOCKERFILES = [
  'apps/wbs/be-01/Dockerfile',
  'apps/wbs/gw-01/Dockerfile',
  'apps/wbs/fe-01/Dockerfile',
  'deploy/dev-src/Dockerfile',
] as const;

describe('the Bun version', () => {
  it('has one source, and it is a bare version', async () => {
    const pinned = (await read('.bun-version')).trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('every Bun image tag equals .bun-version', async () => {
    const pinned = (await read('.bun-version')).trim();
    const drifted: string[] = [];
    for (const file of BUN_DOCKERFILES) {
      // The version alone: `1.4.2-alpine AS deps` and `1.4.2-debian` are both one pin.
      const tags = [...(await read(file)).matchAll(/^FROM oven\/bun:(\d+\.\d+\.\d+)/gm)].map(
        (m) => m[1],
      );
      // A Dockerfile with no Bun stage is a listing error, not a pass.
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) if (tag !== pinned) drifted.push(`${file}: ${tag}`);
    }
    expect(drifted).toEqual([]);
  });

  it('CI reads the file rather than a literal', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    const literals = workflow.match(/^\s*bun-version:/gm) ?? [];
    expect(literals.length).toBe(0);
    const fromFile = workflow.match(/^\s*bun-version-file: \.bun-version$/gm) ?? [];
    // Both jobs set Bun up; one reading the file and one floating is the drift this exists to stop.
    expect(fromFile.length).toBe((workflow.match(/uses: oven-sh\/setup-bun@/g) ?? []).length);
  });

  it('CI and the heavy gate use the moved solver and image paths', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    const gateSteps = await read('bin/h2puni-gate-steps.sh');
    const manifest = await read('tools/tool-devsync/project.json');

    // Proof: the legacy CI solver paths made this production-workflow oracle fail before its
    // first expected cache path; the heavy-gate companion also failed on its old Nx identity
    // (0 passed / 2 failed).
    expect(workflow).toContain(
      'cache-dependency-path: libs/wbs/adapters/solver-py/requirements.lock',
    );
    expect(workflow).toContain(
      'python3 -m pip install --require-hashes -r libs/wbs/adapters/solver-py/requirements.lock',
    );
    expect(workflow).toContain('bunx nx run wbs-be-01:solver-image-smoke');
    expect(gateSteps).toContain('bunx nx run wbs-be-01:solver-image-smoke');
    // Proof: on 2026-09-14, removing the recursive app-manifest glob and this
    // assertion, then warming the real target, let removing `product:wbs` from
    // apps/wbs/fe-01/project.json replay 1/1 from local cache and exit 0. With
    // the input restored, it reran and failed 176/2 in the product/layout guards.
    expect(manifest).toContain('"{workspaceRoot}/apps/**/project.json"');
    expect(manifest).toContain('"{workspaceRoot}/libs/**/project.json"');
    expect(manifest).toContain('"{workspaceRoot}/tools/**/project.json"');
    // Proof: on 2026-09-14, removing this Dockerfile input and assertion, then
    // warming the real target, let a 1.4.2 -> 0.0.0 backend Bun-tag mutation
    // replay 1/1 from local cache and exit 0. Restoring the input reran and
    // failed 177/1 on `apps/wbs/be-01/Dockerfile: 0.0.0`.
    expect(manifest).toContain('"{workspaceRoot}/apps/**/Dockerfile"');
  });
});

describe('namespace-sensitive ignore boundaries', () => {
  it('keeps the development entrypoint out of production image contexts', async () => {
    const dockerIgnore = (await read('.dockerignore')).split('\n');
    // Proof: the pre-move exclusion failed here with the received root file
    // containing only `apps/be-01/src/dev`; the moved entrypoint was absent.
    expect(dockerIgnore).toContain('apps/wbs/be-01/src/dev');
    expect(dockerIgnore).not.toContain('apps/be-01/src/dev');
  });

  it('keeps generated migration and solver artifacts out of formatting', async () => {
    const prettierIgnore = (await read('.prettierignore')).split('\n');
    expect(prettierIgnore).toContain('apps/wbs/be-01/drizzle/**/snapshot.json');
    // Proof: before these moved solver exclusions were added, the received
    // production ignore list ended after the migration snapshot and root/tool
    // exclusions, with neither build-output path present.
    expect(prettierIgnore).toContain('libs/wbs/adapters/solver-py/build/');
    expect(prettierIgnore).toContain('libs/wbs/adapters/solver-py/src/*.egg-info/');
  });

  it('keeps local solver build artifacts under the moved adapter root', async () => {
    const gitIgnore = (await read('.gitignore')).split('\n');
    // Proof: the pre-move file failed this assertion with only
    // `libs/solver-py/build/` and `libs/solver-py/src/*.egg-info/` received.
    expect(gitIgnore).toContain('libs/wbs/adapters/solver-py/build/');
    expect(gitIgnore).toContain('libs/wbs/adapters/solver-py/src/*.egg-info/');
    expect(gitIgnore).not.toContain('libs/solver-py/build/');
    expect(gitIgnore).not.toContain('libs/solver-py/src/*.egg-info/');
  });

  it('declares every root ignore file this cached guard reads', async () => {
    const manifest = await read('tools/tool-devsync/project.json');
    expect(manifest).toContain('"{workspaceRoot}/.dockerignore"');
    expect(manifest).toContain('"{workspaceRoot}/.gitignore"');
    expect(manifest).toContain('"{workspaceRoot}/.prettierignore"');
  });
});

/**
 * TypeScript wears two hats here, and each is pinned to its own major.
 *
 * `tsc` on the workspace path is TypeScript 7 — the native compiler, ten
 * times faster and the one every `typecheck` target runs. TypeScript 7 ships
 * no compiler API, and typescript-eslint needs one (`>=4.8.4 <6.1.0`), so the
 * package that answers `require('typescript')` is `@typescript/typescript6`,
 * installed under the `typescript` name; its only bin is `tsc6`, which is why
 * the two do not collide. The arrangement lives in `package.json`'s two
 * `npm:` aliases and nothing else says which role is which — a swap would
 * leave every typecheck target compiling with TS 6 and ESLint parsing with a
 * package that has no API, and both would still exit 0 on a clean tree.
 *
 * Proof: with no alias at all, both failed — `Expected: "6" · Received: "5"`
 * and `Received: "Version 5.9.3"`. With the two aliases swapped, both failed
 * again on `Expected: "6" · Received: "7"` and `Received: "Version 6.0.3"` —
 * the 6.0.3 being a transitive TypeScript that owned `.bin/tsc` once the
 * TS 7 package no longer did (2026-09-06).
 */
describe('the two TypeScripts', () => {
  const require = createRequire(import.meta.url);

  it('the typescript package is the TS 6 API build', () => {
    const { version } = require('typescript/package.json') as { version: string };
    expect(version.split('.')[0]).toBe('6');
  });

  it('tsc on the workspace path is TypeScript 7', () => {
    const tsc = new URL('node_modules/.bin/tsc', WORKSPACE).pathname;
    const { stdout, exitCode } = Bun.spawnSync([tsc, '--version']);
    expect(exitCode).toBe(0);
    expect(stdout.toString().trim()).toMatch(/^Version 7\./);
  });
});

/**
 * ESLint is told React's version rather than detecting it — see the
 * `settings.react.version` comment in `apps/wbs/eslint.product.mjs` for why — and a told
 * version can go stale. This is the line that says when it has.
 *
 * Proof: with the pin set to `18.3.1` against React 19.2.8 installed,
 * `the React version ESLint is told is the one installed` failed on
 * `Expected: "19.2.8" · Received: "18.3.1"` (2026-09-06).
 */
describe('the React version ESLint is told', () => {
  it('is the one installed', async () => {
    const config = await read('apps/wbs/eslint.product.mjs');
    const told = /settings: \{ react: \{ version: '([^']+)' \} \}/.exec(config)?.[1];
    const require = createRequire(import.meta.url);
    const { version } = require('react/package.json') as { version: string };
    expect(told).toBe(version);
  });
});

interface WorkflowStep {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: { 'fetch-depth'?: number };
}

/**
 * `jobs` names `gate` rather than being a `Record`, for the reason
 * `corpus-lint-workflow.test.ts` gives: an index signature types every lookup as
 * present and `no-unnecessary-condition` then rejects the `?.` a missing job needs.
 */
interface CiWorkflow {
  jobs?: { gate?: { steps?: WorkflowStep[] } };
}

async function readCiWorkflow(): Promise<CiWorkflow> {
  return Bun.YAML.parse(await read('.github/workflows/ci.yml')) as CiWorkflow;
}

function gateStep(workflow: CiWorkflow, name: string): WorkflowStep {
  const step = workflow.jobs?.gate?.steps?.find((candidate) => candidate.name === name);
  expect(step, `the gate job has no \`${name}\` step`).toBeDefined();
  return step ?? {};
}

/**
 * `on` is the one key YAML 1.1 reads as a boolean, so `workflow.on` is undefined and a
 * suite that read it would pass by checking nothing — see `corpus-lint-workflow.test.ts`.
 */
function subscribedEvents(workflow: CiWorkflow): string[] {
  const record = workflow as unknown as Record<string, unknown>;
  // Bracketed because both come from an index signature (TS4111), not style.
  const block = (record['on'] ?? record['true']) as Record<string, unknown> | undefined;
  expect(block, 'the workflow has no `on:` block under either key').toBeDefined();
  return Object.keys(block ?? {});
}

/**
 * The event labels of the OUTER `case` in a script, `*` included, one per alternative.
 *
 * The class deliberately excludes the space that used to be in it. With ` ` inside,
 * `^ {2}` consumed two spaces of a SIX-space nested arm and the class ate the other four,
 * so the inner `case "$tool_wiki_status"`'s own `*)` was harvested as an outer event: the
 * real script yielded `["pull_request", "*", "push", "merge_group", "workflow_dispatch",
 * "*"]` and `toContain('*')` passed with the outer refusal arm deleted. Alternatives are
 * matched as an explicit ` | ` list instead, which only the outer arms are written as.
 */
function caseArmEvents(script: string): string[] {
  return [...script.matchAll(/^ {2}([a-z_]+(?: \| [a-z_]+)*|\*)\)$/gm)].flatMap((match) =>
    match[1].split('|').map((event) => event.trim()),
  );
}

/**
 * A script with every run of whitespace collapsed to one space.
 *
 * A refusal is two lines — say what happened, then stop — and a `toContain` on either line
 * alone pins neither. `exit 1` in particular appears more than once in this script now, so
 * asserting it bare is an assertion that cannot fail; asserting the pair as one normalised
 * string is what makes deleting the `exit` visible.
 *
 * Always applied to `commandsOf(...)`, never to the raw script: a `Proof:` comment beside a
 * pinned arm quotes the literal the pin asserts, and on 2026-09-16 the pixels twin was
 * watched passing on its own comment after one reflow with the arm's `exit 1` deleted.
 */
function oneLine(script: string): string {
  return script.replace(/\s+/g, ' ');
}

/**
 * A shell script's commands, with its WHOLE-LINE comments dropped — a line whose first
 * non-space character is `#` — so counting commands counts commands. A trailing comment on a
 * command line survives, so the guarantee is "a standalone comment cannot satisfy a pin",
 * not "no comment can".
 */
function commandsOf(script: string): string {
  return script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The gate's scope, which is chosen from the event and never inferred.
 *
 * The header of `ci.yml` used to say "deliberately run-many, not affected", and the
 * reason it gave is still the right one: `nx affected` with a wrong or missing base is a
 * gate that silently narrows. What changed is where the base comes from — the pull
 * request's own immutable payload SHA, refused when empty — and that `merge_group` and
 * `push` keep the full run, so nothing narrows for `main`. This suite is what holds the
 * workflow to that, because a scope that moves without saying so is the whole hazard.
 */
describe('the CI gate scope', () => {
  it('maps every subscribed event and refuses one it has no rule for', async () => {
    // Proofs re-observed 2026-09-16 on the shipped tree, because the first pair of them was
    // written before the nested `case "$tool_wiki_status"` existed and stopped reproducing
    // when it landed — see `caseArmEvents` above:
    //
    // 1. Whole `*)` arm deleted from `Gate mode`: fails on the star assertion below with
    //    `Expected: ["*"] · Received: []` — 16 passed / 1 failed. It could not fail before:
    //    the old extractor harvested the nested `case "$tool_wiki_status"`'s `*)` too, so
    //    `arms` was `["pull_request", "*", "push", "merge_group", "workflow_dispatch", "*"]`
    //    and a `toContain('*')` passed with this arm gone.
    // 2. Only the arm's `exit 1` deleted, leaving the message — the log-and-continue shape
    //    AGENTS.md forbids: fails on `Expected to contain: "printf 'no gate mode for event
    //    %s\\n' \"$EVENT_NAME\" >&2 exit 1"` — 16 passed / 1 failed. Before this fix that
    //    fault left every case green, because the `type == "array"` guard in the same script
    //    supplies a second `exit 1` for a bare `toContain('exit 1')` to find.
    //
    // The set equality is the other half: adding a trigger to `on:` without a case arm
    // fails on the two sets rather than choosing a scope by accident.
    const workflow = await readCiWorkflow();
    const script = gateStep(workflow, 'Gate mode').run ?? '';
    const arms = caseArmEvents(script);

    // Exactly one `*`, sorted rather than positional — the `on:` key order is not the arm
    // order and neither is a contract.
    expect(arms.filter((event) => event === '*')).toEqual(['*']);
    expect(arms.filter((event) => event !== '*').sort()).toEqual(subscribedEvents(workflow).sort());
    expect(oneLine(commandsOf(script))).toContain(
      `printf 'no gate mode for event %s\\n' "$EVENT_NAME" >&2 exit 1`,
    );
  });

  it('takes the pull-request boundary from the immutable payload', async () => {
    const step = gateStep(await readCiWorkflow(), 'Gate mode');

    // The same shape `Corpus version lint` uses: payload values arrive as environment
    // variables, never interpolated into the shell, and a mutable ref is not a fallback.
    expect(step.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    });
    expect(step.env).not.toHaveProperty('PR_BASE_REF');
    expect(step.run).toContain(`: "\${PR_BASE_SHA:?pull_request payload carries no base SHA}"`);
    // Pinned as the ARM, not as three loose literals. `toContain` on each printf says only
    // that the strings exist somewhere in the script — it is equally happy with the two arm
    // bodies swapped, which is `mode=full` on pull requests and `mode=affected`, with no
    // base, on everything else.
    //
    // Proof (2026-09-16): with the `pull_request` and `push | merge_group |
    // workflow_dispatch` bodies exchanged in the production workflow, this failed on
    // `Expected to contain: "pull_request) : \"${PR_BASE_SHA:?pull_request payload carries
    // no base SHA}\" printf 'mode=affected\\n' >> \"$GITHUB_OUTPUT\""` — 16 passed /
    // 1 failed.
    const mode = oneLine(commandsOf(step.run ?? ''));
    expect(mode).toContain(
      `pull_request) : "\${PR_BASE_SHA:?pull_request payload carries no base SHA}" ` +
        `printf 'mode=affected\\n' >> "$GITHUB_OUTPUT"`,
    );
    expect(mode).toContain(`printf 'base=%s\\n' "$PR_BASE_SHA" >> "$GITHUB_OUTPUT"`);
    expect(mode).toContain(
      `push | merge_group | workflow_dispatch) printf 'mode=full\\n' >> "$GITHUB_OUTPUT" ` +
        `printf 'tool_wiki=run\\n' >> "$GITHUB_OUTPUT" ;;`,
    );
  });

  it('runs affected on a pull request and the unchanged full gate everywhere else', async () => {
    const step = gateStep(await readCiWorkflow(), 'Gate — test, lint, typecheck, build');
    const script = commandsOf(step.run ?? '');

    expect(step.env).toEqual({
      GATE_MODE: '${{ steps.gate_mode.outputs.mode }}',
      GATE_BASE: '${{ steps.gate_mode.outputs.base }}',
      GATE_TOOL_WIKI: '${{ steps.gate_mode.outputs.tool_wiki }}',
    });
    // The SELECTOR and the BRANCH BODIES, not only the two command lines. Until 2026-09-16
    // nothing pinned either, and each gap has its own way of narrowing `push` and
    // `merge_group` to `nx affected --base=""` — the silent narrowing this change exists to
    // avoid, on the two events that must never narrow.
    //
    // Pinning the predicate alone is not enough, and this file claimed otherwise for one
    // commit: with the predicate intact and the `then`/`else` BODIES exchanged, every
    // assertion here passed — the predicate text is present, both command lines are present,
    // and all three occurrence counts are unchanged, because a swap moves commands without
    // adding or removing any. Watched 2026-09-16: 17 passed / 0 failed on that fault. So the
    // branch and its body are pinned together, as one normalised string each.
    //
    // Proof (2026-09-16), each fault watched separately against the production workflow:
    //   predicate -> `if true; then`   fails on `Expected to contain: "if [ \"$GATE_MODE\" =
    //                                  affected ]; then"`, 16 passed / 1 failed
    //   bodies exchanged               fails on `Expected to contain: "if [ \"$GATE_MODE\" =
    //                                  affected ]; then { bunx nx affected -t test lint
    //                                  typecheck build --base=\"$GATE_BASE\" --head=HEAD"`,
    //                                  16 passed / 1 failed
    const branches = oneLine(commandsOf(step.run ?? ''));
    expect(script).toContain('if [ "$GATE_MODE" = affected ]; then');
    expect(branches).toContain(
      'if [ "$GATE_MODE" = affected ]; then { ' +
        'bunx nx affected -t test lint typecheck build --base="$GATE_BASE" --head=HEAD',
    );
    expect(branches).toContain('else { bunx nx run-many -t test lint typecheck build --parallel=2');
    expect(script).toContain(
      'bunx nx affected -t test lint typecheck build --base="$GATE_BASE" --head=HEAD',
    );
    expect(script).toContain('bunx nx run-many -t test lint typecheck build --parallel=2');
    // Both branches keep the same three parts: the workspace run without Tool Wiki, Tool
    // Wiki's own targets, and its explicit source lint. Counting rather than containing,
    // because one branch quietly losing a part is exactly what this is here to see.
    expect(occurrences(script, '--exclude=wiki-cli')).toBe(2);
    expect(occurrences(script, 'bunx nx run-many -t test typecheck build -p wiki-cli')).toBe(2);
    expect(
      occurrences(script, 'bunx nx run wiki-cli:lint:source --skip-nx-cache --output-style=stream'),
    ).toBe(2);
  });

  it('keeps Tool Wiki in the pull-request gate, read as JSON rather than grepped', async () => {
    // Proof (2026-09-16): with the `if [ "$GATE_TOOL_WIKI" = run ]` branch replaced by
    // `true` in the affected arm of the production workflow, this case failed on
    // `Expected to contain: "if [ \"$GATE_TOOL_WIKI\" = run ]; then"` and the case above
    // failed on `Expected: 2 · Received: 1` for
    // `bunx nx run-many -t test typecheck build -p wiki-cli` — 2 failed / 14 passed. A
    // pull request touching Tool Wiki would have gated everything except Tool Wiki.
    // The `not.toContain('grep')` is the second fault this pins: measured on Nx 23.2.0,
    // 2026-09-16, `bunx nx show projects --affected --base=HEAD~1 --head=HEAD` prints a
    // ONE-LINE JSON array on a non-TTY runner whatever `--sep` asks for, so a
    // `grep -qx wiki-cli` over it can never match and would drop Tool Wiki from every
    // pull request while exiting 0.
    const workflow = await readCiWorkflow();
    const mode = commandsOf(gateStep(workflow, 'Gate mode').run ?? '');
    const gate = commandsOf(gateStep(workflow, 'Gate — test, lint, typecheck, build').run ?? '');

    expect(mode).toContain(
      'bunx nx show projects --affected --base="$PR_BASE_SHA" --head=HEAD --json',
    );
    expect(mode).toContain(`jq -s -e '.[0] | index("wiki-cli") != null'`);
    expect(mode).not.toContain('grep');
    expect(mode).toContain(`printf 'tool_wiki=run\\n' >> "$GITHUB_OUTPUT"`);
    expect(mode).toContain(`printf 'tool_wiki=skip\\n' >> "$GITHUB_OUTPUT"`);
    expect(gate).toContain('if [ "$GATE_TOOL_WIKI" = run ]; then');
  });

  it('refuses a jq failure instead of reading it as Tool Wiki being unaffected', async () => {
    // `if jq -e … ; then run; else skip; fi` conflates two different answers. jq exits 1 for
    // `false` and 2 or more for an error — a parse failure on polluted stdout, a type error —
    // and the `else` swallowed both, so a broken read would have dropped Tool Wiki from the
    // pull-request gate while the step exited 0. That is the exact shape this repo's incident
    // catalogue is made of, and it contradicted this change's own spec scenario: "the affected
    // project list cannot be computed → the gate-mode step fails".
    //
    // Proof (2026-09-16), two halves. The oracle: with the production switch returned to its
    // two-branch `if jq -e 'index("tool-wiki") != null' … then … else … fi`, this failed on
    // the missing array guard — 16 passed / 1 failed.
    //
    // `-s` is the second half of the guard and it is load-bearing. Without it jq judges only
    // the LAST document in its input. Watched through this production step script, driven
    // with a `bunx` stub printing `"tool-wiki"` and then `["wbs-be-01","tool-devsync"]`:
    // the unslurped form wrote `tool_wiki=skip` and exited 0 — with `tool-wiki` right there
    // in the output — while this one printed `nx show projects did not return one JSON
    // array: …` and exited 1. Same form as `bin/h2puni-gate-steps.sh`.
    // The behaviour, both forms run in a real shell on
    // `affected='Nx read error: could not find project graph'`: the two-branch form printed
    // `tool_wiki=skip` and exited 0 — the silent drop — while this one printed
    // `nx show projects did not return one JSON array: Nx read error…` and exited 1. (That
    // measurement predates `-s`; the message it quotes is the current one.)
    //
    // Stated at the strength it is known: once the output IS a validated array, the
    // membership filter returns true or false and never errors — `[1,2]`, `[{"a":1}]`,
    // `["a","b"]` and `[[1],[2]]` all exit 1, checked. So the `*)` arm guards jq ITSELF
    // failing, not a shape the guard above already caught, and it was watched doing that:
    // with a `jq` stub that works once and then exits 2, the step printed
    // `jq failed reading the affected project list (status 2)` and exited 2, where the
    // two-branch form would have recorded Tool Wiki as unaffected.
    const mode = commandsOf(gateStep(await readCiWorkflow(), 'Gate mode').run ?? '');

    // The shape is: assert the output IS an array, then branch on the explicit status.
    expect(mode).toContain(`jq -s -e 'length == 1 and (.[0] | type == "array")'`);
    expect(mode).toContain('tool_wiki_status=0');
    expect(mode).toContain('|| tool_wiki_status=$?');
    expect(mode).toContain('exit "$tool_wiki_status"');
    expect(mode.indexOf(`jq -s -e 'length == 1 and (.[0] | type == "array")'`)).toBeLessThan(
      mode.indexOf(`jq -s -e '.[0] | index("wiki-cli") != null'`),
    );
  });

  it('checks the gate job out at full depth, which --base cannot resolve without', async () => {
    const workflow = await readCiWorkflow();
    const checkout = workflow.jobs?.gate?.steps?.find(({ uses }) =>
      uses?.startsWith('actions/checkout@'),
    );

    expect(checkout, 'the gate job has no checkout step').toBeDefined();
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
