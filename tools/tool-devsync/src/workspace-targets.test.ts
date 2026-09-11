import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';
import {
  createProjectGraphAsync,
  type NxJsonConfiguration,
  type ProjectGraph,
} from 'nx/src/devkit-exports';
import { filterUsingGlobPatterns, getTargetInputs } from 'nx/src/hasher/task-hasher';

import { readProjects } from '../workspace-projects.mjs';

/**
 * `tsc -p` on a solution-style config compiles **nothing**.
 *
 * A solution config carries `"files": []`, `"include": []` and a `references`
 * list. `tsc --build` follows those references; `tsc --noEmit -p` does not — it
 * loads the zero files the config names and exits 0. A target written that way
 * is a check that cannot fail, which is the fault CLAUDE.md's ledger records as
 * having shipped three times: be-01 and fe-01 (2026-08-06), gw-01 (2026-08-09),
 * and every `libs/*` and `tools/*` project until 2026-09-02, when this test was
 * written. On that day 18 of 23 targets compiled nothing, and `swap.ts` — 1,033
 * lines that swap production — was typechecked by nothing at all.
 *
 * This walks the projects rather than trusting a list, in the shape of
 * `RESTART_PATHS coverage` below: a project added with the wrong form fails
 * here rather than reporting green over code no compiler has read.
 *
 * Proof: with `tools/tool-remote-scripts/project.json` put back to
 * `bunx tsc --noEmit -p tools/tool-remote-scripts/tsconfig.json`, watched
 * failing on `Expected value to be empty · Received: [ "tool-remote-scripts" ]`
 * (2026-09-02).
 * The same fault was watched through the target itself: with
 * `const deliberatelyWrong: number = 'not a number'` appended to `swap.ts`,
 * the old command exited 0 in 0.156s and the new one failed on
 * `swap.ts(1035,7): error TS2322`.
 */
const WORKSPACE = new URL('../../../', import.meta.url);

interface ProjectTarget {
  readonly options?: Readonly<{ command?: string; commands?: readonly string[] }>;
  readonly inputs?: readonly (string | Readonly<Record<string, unknown>>)[];
}

interface ProjectConfig {
  readonly name: string;
  readonly tags: readonly string[];
  readonly targets: Readonly<Record<string, ProjectTarget | undefined>>;
}

/** Every recursively discovered project, adapted to this file's older call sites. */
async function projectsOnDisk(): Promise<{ dir: string; config: ProjectConfig }[]> {
  return (await readProjects(WORKSPACE)).map((project) => ({
    dir: project.root,
    config: project,
  }));
}

/** Whether this library owns a tracked `*.test.ts(x)` not filed in the database tier. */
async function hasUnitSuite(projectDir: string): Promise<boolean> {
  const tests = new Bun.Glob('src/**/*.test.{ts,tsx}');
  for await (const path of tests.scan({ cwd: new URL(`${projectDir}/`, WORKSPACE).pathname })) {
    if (!/\.db\.test\.tsx?$/.test(path)) return true;
  }
  return false;
}

/** The shell commands a target runs, whether it spells one or several. */
function commandsOf(target: ProjectTarget): string[] {
  return [
    ...(target.options?.command === undefined ? [] : [target.options.command]),
    ...(target.options?.commands ?? []),
  ];
}

describe('every typecheck target compiles files', () => {
  it('finds a project.json for every project', async () => {
    const projects = await projectsOnDisk();
    expect(projects.length).toBeGreaterThan(20);
  });

  it('never runs `tsc -p` against a solution-style config', async () => {
    const offenders: string[] = [];
    for (const { config } of await projectsOnDisk()) {
      const target = config.targets['typecheck'];
      if (target === undefined) continue;
      for (const command of commandsOf(target)) {
        const project = /tsc\s[^&|]*?--noEmit[^&|]*?-p\s+(\S+)/.exec(command)?.[1];
        if (project === undefined) continue;
        const raw = await readFile(new URL(project, WORKSPACE), 'utf8');
        // A solution config names no files of its own and delegates to
        // references; `-p` reads the former and ignores the latter.
        const compilesNothing =
          /"files"\s*:\s*\[\s*\]/.test(raw) && /"include"\s*:\s*\[\s*\]/.test(raw);
        if (compilesNothing) offenders.push(config.name);
      }
    }
    expect(offenders).toBeEmpty();
  });

  it('builds each project’s own solution config, so its tests are compiled too', async () => {
    // The fault `tsc -p` above is the *other* half of: a target that builds a
    // **sub**-config (`tsconfig.lib.json`, `tsconfig.app.json`) compiles the
    // source and leaves the spec project — every test file the project has —
    // read by nothing. That is how 229 type errors accumulated unseen in
    // be-01, fe-01 and gw-01, and how a fake stopped satisfying `ProjectApi`
    // while its suite stayed green (`d4b62a30`). `tsc --build` on the solution
    // config follows every reference, so the tests are compiled with the code.
    //
    // Proof: with `apps/gw-01/project.json` put back to
    // `bunx tsc --build --force apps/gw-01/tsconfig.lib.json`, watched failing
    // on `Expected value to be empty · Received: [ "gw-01" ]` (2026-09-02).
    const offenders: string[] = [];
    for (const { dir, config } of await projectsOnDisk()) {
      const target = config.targets['typecheck'];
      if (target === undefined) continue;
      const builds = commandsOf(target).some((command) =>
        new RegExp(`tsc\\s[^&|]*?--build[^&|]*?\\s${dir}/tsconfig\\.json(\\s|$)`).test(command),
      );
      if (!builds) offenders.push(config.name);
    }
    expect(offenders).toBeEmpty();
  });

  it('references every spec config from the solution config that names it', async () => {
    // A `tsconfig.spec.json` the solution config does not reference is a spec
    // project `tsc --build` never reaches — the same blindness one file down,
    // and invisible to the case above because the command would still look
    // right.
    //
    // Proof: with the `./tsconfig.spec.json` reference struck from
    // `apps/gw-01/tsconfig.json`, watched failing on `Expected value to be
    // empty · Received: [ "apps/gw-01" ]` (2026-09-02).
    const orphans: string[] = [];
    for (const { dir } of await projectsOnDisk()) {
      let spec: string;
      try {
        spec = await readFile(new URL(`${dir}/tsconfig.spec.json`, WORKSPACE), 'utf8');
      } catch {
        // A project with no spec config has no test files to lose.
        continue;
      }
      expect(spec.length).toBeGreaterThan(0);
      const solution = await readFile(new URL(`${dir}/tsconfig.json`, WORKSPACE), 'utf8');
      if (!solution.includes('./tsconfig.spec.json')) orphans.push(dir);
    }
    expect(orphans).toBeEmpty();
  });

  it('gives every TypeScript project a typecheck target', async () => {
    const missing = (await projectsOnDisk())
      .filter(({ config }) => !config.tags.includes('runtime:python'))
      .filter(({ config }) => config.targets['typecheck'] === undefined)
      .map(({ dir }) => dir);
    expect(missing).toBeEmpty();
  });
});

/**
 * A cached target that reads a file Nx does not know about is a check that
 * cannot fail.
 *
 * Nx hashes a task from its declared `inputs`. The defaults cover the project's
 * own directory and its dependencies' — nothing else. A suite that reaches
 * outside, as nine of them do, replays from cache when the file it is about
 * changes, and reports green over a change no command read.
 *
 * The nine on 2026-09-02: five suites drive shell scripts under `bin/`, three
 * read shipped Caddy and Compose fragments under `deploy/`, and `libs/domain`'s
 * `every name it can answer is one the migration seeds` reads a be-01 migration
 * to prove the two lists are one fact — an anti-drift check whose own input was
 * invisible to the thing deciding whether to run it.
 *
 * This walks the suites rather than trusting a list. A path is covered when a
 * declared input matches it, or names something inside it when the read is a
 * directory.
 *
 * Proof: with `inputs` deleted from `tool-devsync`'s `test` target, watched
 * failing on `Expected value to be empty · Received: [ "tool-devsync:test does
 * not declare apps", "tool-devsync:test does not declare bin/dev-be-probe.sh",
 * …`; and with `libs/domain`'s deleted, on `Received: [ "domain:test does not
 * declare apps/be-01/drizzle/20260830020000_add_external_ref/migration.sql" ]`.
 *
 * The fault itself was watched through Nx the same day: with `tool-devsync`'s
 * declaration removed, an edit to `bin/dev-be-probe.sh` gave `nx run
 * tool-devsync:test  [existing outputs match the cache, left as is]`, and with
 * it restored the same edit ran the suite.
 */
/** Workspace-relative paths a `*.test.ts` reads from outside its own project. */
async function outsideReads(projectDir: string): Promise<string[]> {
  const found = new Set<string>();
  const glob = new Bun.Glob('src/**/*.test.ts');
  for await (const relative of glob.scan({ cwd: new URL(`${projectDir}/`, WORKSPACE).pathname })) {
    const source = await readFile(new URL(`${projectDir}/${relative}`, WORKSPACE), 'utf8');
    for (const [, up] of source.matchAll(/'((?:\.\.\/){3,}[A-Za-z0-9_./-]*)'/g)) {
      // Resolved against the file, then made workspace-relative. An empty
      // result is the workspace root itself or above it — a path being built,
      // not a file being read, and too broad to ask any target to declare.
      const resolved = new URL(up, new URL(`${projectDir}/${relative}`, WORKSPACE)).pathname;
      const root = WORKSPACE.pathname;
      if (!resolved.startsWith(root)) continue;
      const rel = resolved.slice(root.length).replace(/\/$/, '');
      if (rel === '' || rel.startsWith(`${projectDir}/`)) continue;
      found.add(rel);
    }
  }
  return [...found].sort();
}

/** Whether Nx hashes `read` through the target's declared dependency inputs. */
function dependencyInputCovers(
  read: string,
  projectName: string,
  projectGraph: ProjectGraph,
  nxJson: NxJsonConfiguration,
): boolean {
  if (!(projectName in projectGraph.nodes))
    throw new Error(`Nx graph has no project ${projectName}`);
  const project = projectGraph.nodes[projectName];
  const owner = Object.values(projectGraph.nodes)
    .filter(({ data: { root } }) => read === root || read.startsWith(`${root}/`))
    .sort((left, right) => right.data.root.length - left.data.root.length)
    .at(0);
  if (owner === undefined) return false;
  if (!(projectGraph.dependencies[projectName] ?? []).some(({ target }) => target === owner.name)) {
    return false;
  }
  const patterns = getTargetInputs(nxJson, project, 'test').dependencyInputs;
  return (
    filterUsingGlobPatterns(owner.data.root, [{ file: read, hash: 'coverage-probe' }], patterns)
      .length === 1
  );
}

describe('every cached target declares what it reads', () => {
  it('names every file a suite reads from outside its own project', async () => {
    const nxJson = JSON.parse(
      await readFile(new URL('nx.json', WORKSPACE), 'utf8'),
    ) as NxJsonConfiguration;
    const shared = nxJson.namedInputs?.['sharedGlobals'];
    expect(shared).toBeDefined();
    const projectGraph = await createProjectGraphAsync({ exitOnError: true });

    const undeclared: string[] = [];
    for (const { dir, config } of await projectsOnDisk()) {
      const reads = await outsideReads(dir);
      if (reads.length === 0) continue;
      const declared = [...(config.targets['test']?.inputs ?? []), ...(shared ?? [])]
        .filter(
          (each): each is string => typeof each === 'string' && each.startsWith('{workspaceRoot}/'),
        )
        .map((each) => each.slice('{workspaceRoot}/'.length));
      for (const read of reads) {
        const covered = declared.some(
          (pattern) =>
            new Bun.Glob(pattern).match(read) ||
            // A directory read is covered by any declared input inside it:
            // that is what makes the directory's contents part of the hash.
            pattern.startsWith(`${read}/`),
        );
        // Proof: ignoring dependency inputs failed on
        // `be-01:test does not declare libs/runtime-portable/src/scheduler.ts`,
        // even though Nx hashes that production file through `^production`.
        if (!covered && !dependencyInputCovers(read, config.name, projectGraph, nxJson)) {
          undeclared.push(`${config.name}:test does not declare ${read}`);
        }
      }
    }
    expect(undeclared).toBeEmpty();
  });
});

/**
 * Every `.ts` under `root`, recursively, with the workspace-relative path it
 * was read from.
 *
 * Tests included: a copy of the union in a test file is a second declaration
 * too, and the one place they are legitimately written out is the contract's
 * own file.
 */
async function sourceFilesIn(root: URL, prefix: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A project with no `src/` — `tools/dev` is one. Not an unknown: the
    // listing above is what says which projects exist, and a project without
    // sources contributes none.
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(
        ...(await sourceFilesIn(new URL(`${entry.name}/`, root), `${prefix}/${entry.name}`)),
      );
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    found.push({
      path: `${prefix}/${entry.name}`,
      text: await readFile(new URL(entry.name, root), 'utf8'),
    });
  }
  return found;
}

/**
 * The deploy vocabulary is declared **once**.
 *
 * `Tier` was written out four times and inline twice more, `Color` three times,
 * and the image names, container names and ports twice each — across four
 * projects that have to agree or a deploy pushes an image the server will not
 * run. `@wbs/deploy-contract` is the one declaration since 2026-09-02, and this
 * is what stops the copies coming back: a re-declared union reads exactly like
 * the original to anybody who does not go looking for the other three.
 *
 * A text scan for the same reason `audit.test.ts` is one — what has to be
 * refused is a *shape*, and no type can state "and nowhere else". The contract
 * file itself is exempt, and it is the only exemption.
 *
 * Proof: the tier union put back as a `Tier` declaration at the top of
 * `tools/tool-deploy/src/affected.ts`, watched failing on `Expected value to be
 * empty · Received: [ "tools/tool-deploy/src/affected.ts re-declares …" ]`; and
 * with the colour union restored in `tools/tool-smoke/src/color.ts`, on the
 * same message for that file (2026-09-02).
 *
 * The unions are **assembled** in the case below rather than written out,
 * because this file would otherwise be a copy of the thing it refuses — and the
 * JSDoc says them the long way round for the same reason.
 */
describe('the deploy contract', () => {
  const CONTRACT = 'tools/tool-remote-scripts/src/lib/deploy-contract.ts';

  it('is the only place a tier or a colour is spelled out', async () => {
    const copies: string[] = [];
    for (const project of await readProjects(WORKSPACE)) {
      const root = new URL(`${project.root}/src/`, WORKSPACE);
      for (const file of await sourceFilesIn(root, `${project.root}/src`)) {
        if (file.path === CONTRACT) continue;
        // Assembled rather than written out, so this file is not a copy of
        // the thing it refuses. Exempting itself instead would have exempted
        // every future test in it too.
        const unions = [
          ['be', 'gw', 'fe'].map((tier) => `'${tier}'`).join(' | '),
          ['blue', 'green'].map((color) => `'${color}'`).join(' | '),
        ];
        for (const union of unions) {
          if (file.text.includes(union)) copies.push(`${file.path} re-declares ${union}`);
        }
      }
    }
    expect(copies).toBeEmpty();
  });

  it('is reading real sources, not an empty listing', async () => {
    // The case above passes over an empty file list, for a wrong reason: a
    // renamed directory, a filter that dropped every file.
    const root = new URL('tools/tool-remote-scripts/src/', WORKSPACE);
    const files = await sourceFilesIn(root, 'tools/tool-remote-scripts/src');
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((file) => file.path)).toContain(CONTRACT);
  });
});

/**
 * A dependency rule the linter cannot find on a project is a rule that never
 * fires for that project.
 *
 * `@nx/enforce-module-boundaries` matches on tags, so a project carrying no
 * `ring:` tag is not constrained by any ring rule — it is simply not in the
 * question. That is the shape of every "check that cannot fail" in this
 * repository's ledger, moved up a level: the config looks like a rule and the
 * project it should have governed is invisible to it. Two tags rather than
 * none is the same fault wearing the other hat, because the first matching
 * `depConstraints` entry wins and which one that is depends on the order they
 * happen to be written in.
 *
 * Walked rather than listed, in the shape of the typecheck test above: a
 * project added tomorrow with no ring fails here rather than being quietly
 * exempt from the direction the whole extraction exists to enforce.
 */
describe('every project says which ring, scope and runtime it is', () => {
  const AXES = ['scope:', 'ring:', 'runtime:'] as const;

  it('carries exactly one tag on each axis', async () => {
    const wrong: string[] = [];
    try {
      for (const { config } of await projectsOnDisk()) {
        const name = config.name;
        for (const axis of AXES) {
          const held = config.tags.filter((tag) => tag.startsWith(axis));
          if (held.length === 0) wrong.push(`${name}: no ${axis}`);
          if (held.length > 1) wrong.push(`${name}: two ${axis} tags`);
        }
      }
    } catch (failure) {
      if (
        !(failure instanceof Error) ||
        !/\.json must carry exactly one (?:scope:|ring:|runtime:) tag; found \d+$/.test(
          failure.message,
        )
      ) {
        throw failure;
      }
      wrong.push(failure.message);
    }
    // Proof: removing `ring:adapter` from the discovered nested supervisor-protocol
    // project failed this assertion with its manifest path and `found 0`; adding
    // `ring:domain` beside it failed with the same path and `found 2`. Removing
    // the ring from `tools/dev/project.json` likewise failed here with its path.
    // Proof: after the focused Nx target returned a 1/1 cache hit, removing the
    // nested ring forced the target to execute and fail here with that path,
    // proving the recursive manifest input invalidates its cache. Watched 2026-09-10.
    expect(wrong).toEqual([]);
  });

  it('puts every tool in the adapter ring', async () => {
    // A tool calls adapters and nothing calls a tool, so `ring:adapter` is the
    // only honest answer for one — and a tool tagged `ring:domain` would be
    // allowed to import nothing at all, which reads as a working constraint
    // until somebody adds an import.
    const wrong: string[] = [];
    for (const { dir, config } of await projectsOnDisk()) {
      if (!dir.startsWith('tools/')) continue;
      if (!config.tags.includes('ring:adapter')) wrong.push(config.name);
    }
    expect(wrong).toEqual([]);
  });
});

describe('the root fast tier discovers every eligible project', () => {
  it('requires a test:unit target independently of target presence', async () => {
    const projects = await projectsOnDisk();
    const requiredNonLibraries = new Set(['be-01', 'fe-01']);
    const missing: string[] = [];
    const unexpected: string[] = [];
    for (const { dir, config } of projects) {
      const declared = config.targets['test:unit'] !== undefined;
      if (!dir.startsWith('libs/')) {
        if (requiredNonLibraries.has(config.name) && !declared) missing.push(config.name);
        if (!requiredNonLibraries.has(config.name) && declared) unexpected.push(config.name);
        continue;
      }
      const eligible = !config.tags.includes('runtime:python') && (await hasUnitSuite(dir));
      if (eligible && !declared) missing.push(config.name);
      if (!eligible && declared) unexpected.push(config.name);
    }
    // Proof: removing `test:unit` from the recursively discovered nested
    // supervisor-protocol project failed this assertion with `missing:
    // ["solver-supervisor-protocol"]` and `unexpected: []` (2026-09-10).
    // Adding `test:unit` to the discovered tool-devsync project failed here
    // with `missing: []` and `unexpected: ["tool-devsync"]` (2026-09-10).
    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
  });

  it('selects the discovered target rather than naming projects', async () => {
    const root: unknown = JSON.parse(await readFile(new URL('package.json', WORKSPACE), 'utf8'));
    if (
      typeof root !== 'object' ||
      root === null ||
      !('scripts' in root) ||
      typeof root.scripts !== 'object' ||
      root.scripts === null
    ) {
      throw new Error('package.json has no scripts object');
    }
    // Proof: a temporary eligible project nested at
    // `libs/fast-tier-proof/nested` appeared in the real root run's 16-project
    // inventory, and its deliberate assertion failed on Expected: false,
    // Received: true. Watched through `bun run test:unit` on 2026-09-10.
    expect(Reflect.get(root.scripts, 'test:unit')).toBe('nx run-many -t test:unit');
  });
});
