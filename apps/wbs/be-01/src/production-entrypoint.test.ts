import { describe, expect, it } from 'bun:test';

/**
 * What the production entrypoint can execute, asked of the entrypoint rather
 * than of a reader.
 *
 * `apps/be-01/Dockerfile` runs `bun run src/main.ts`, so the code a production
 * process can reach is exactly `main.ts`'s import graph. Bundling that graph
 * and reading it is therefore not a proxy for the artifact — it IS the
 * reachable module set, and the only thing the image adds is files that nothing
 * imports.
 *
 * The claim under test is the one the local-solver profile rests on: selection
 * is structural. There is no environment variable that turns a local Python
 * spawn on inside `main.ts`; the two entrypoints are different files, and this
 * is what stops that from being an argument rather than a check.
 */
const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

/**
 * Bundled through the CLI rather than `Bun.build`, and from the repo root.
 *
 * The workspace's `@wbs/*` specifiers are tsconfig paths, which the programmatic
 * builder does not resolve from a test's own directory — it failed with
 * `Could not resolve: "@wbs/domain"` and would have reported an empty graph as
 * a clean one. This is the same command `be-01:build` runs, without `--outdir`,
 * so nothing stale on disk can answer for a source tree that changed.
 */
function productionGraph(): string {
  const built = Bun.spawnSync({
    cmd: ['bun', 'build', 'apps/be-01/src/main.ts', '--target=bun'],
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (built.exitCode !== 0) {
    throw new Error(`bundling the production entrypoint failed: ${built.stderr.toString()}`);
  }
  const graph = built.stdout.toString();
  // A build that emitted nothing would make every `not.toContain` below pass.
  if (graph.length < 100_000) {
    throw new Error(`the production bundle is implausibly small: ${String(graph.length)} bytes`);
  }
  return graph;
}

/**
 * Strings only the local solver defines, so a hit is a hit on that module
 * rather than on a word that happens to be common: the capability record's
 * discriminator, one of the absences it reports, the factory's name, and the
 * dev entrypoint's own refusal sentence.
 */
const LOCAL_SOLVER_MARKERS = [
  'local-solver',
  'no-immediate-termination',
  'createLocalSolverSpawner',
  'no solver environment at',
] as const;

describe('the production entrypoint', () => {
  /**
   * Every marker here is a string only the local solver defines, so a hit is a
   * hit on that module rather than on a word that happens to be common.
   *
   * Proof: giving `main.ts` the env-var selection this design exists to make
   * unspellable — `process.env['WBS_LOCAL_SOLVER'] === 'true' ?
   * createLocalSolverSpawner(...) : solverSupervisorSpawner(...)` — failed this
   * case with `Received + 5`, listing `local-solver`,
   * `no-immediate-termination` and `createLocalSolverSpawner`. The fourth
   * marker stayed absent because that injection imports the spawner without the
   * dev entrypoint, which is the narrower and more likely leak.
   */
  it('cannot reach the local solver', () => {
    const graph = productionGraph();
    // Asserted as the list of markers FOUND rather than with `not.toContain`,
    // which on failure prints the whole 2.7MB bundle and buries the one fact
    // the reader needs.
    expect(LOCAL_SOLVER_MARKERS.filter((marker) => graph.includes(marker))).toEqual([]);
  });

  /**
   * The negative's other half: the marker strings are only absent because the
   * module is unreachable, not because they were never spellable. A test whose
   * markers had been renamed away would pass for ever while the spawner sat in
   * the graph under new names.
   */
  it('does reach the supervisor spawner it is supposed to use', () => {
    const graph = productionGraph();
    expect(graph).toContain('solverSupervisorSpawner');
    expect(graph).toContain('/run/wbs-solver/supervisor.sock');
  });
});
