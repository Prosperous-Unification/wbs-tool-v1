import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

// TASK-160, finding 4. `configure-caddy.test.ts` asserts on configure.sh's
// SOURCE TEXT, so it catches a wholesale revert to `cat > "$caddyfile"` and
// nothing subtler: a filter that keeps only the imports it owns, a mishandled
// trailing comment, a swallowed grep error. Those are the regressions that
// take five live vhosts down, and a string match cannot see any of them.
//
// So this file RUNS the merge block instead. The block is sliced out of the
// shipped script rather than re-typed here — a copy would drift, and a test
// that passes against a copy of the code proves nothing about the code.
const configureShPath = join(import.meta.dir, 'configure.sh');
const configureSh = readFileSync(configureShPath, 'utf8');

const sliceOrThrow = (start: string, end: string): string => {
  const a = configureSh.indexOf(start);
  if (a < 0) {
    throw new Error(
      `configure.sh no longer contains ${JSON.stringify(start)}; this harness slices the shipped script, so the marker needs updating rather than deleting`,
    );
  }
  const b = configureSh.indexOf(end, a);
  if (b < 0) {
    throw new Error(
      `configure.sh no longer contains ${JSON.stringify(end)} after ${JSON.stringify(start)}`,
    );
  }
  return configureSh.slice(a, b + end.length);
};

// TASK-160, Gemini round 8. The harness used to pin WBS_USER to 'wbs-test' and
// BUN_VERSION to 'stubbed', so the value a REAL host has -- the script's own
// default -- appeared in no cell of the product at all, and
//
//   if [ "$WBS_USER" != "puni1" ]; then <merge> fi
//
// was true in all 128 cells and false on every real host. Varying an input is
// not enough: one of the two values has to be the one the shipped script
// actually uses. Read out of configure.sh rather than re-typed, for the same
// reason the merge block is sliced instead of copied -- a copy drifts, and a
// harness that drifts from the script proves nothing about the script.
const shippedDefault = (name: string): string => {
  const m = new RegExp(`^${name}="\\$\\{${name}:-(.*)\\}"$`, 'm').exec(configureSh);
  if (m === null) {
    throw new Error(
      `configure.sh no longer defaults ${name} as \`${name}="\${${name}:-...}"\`; this harness reads its defaults out of the script, so the pattern needs updating rather than deleting`,
    );
  }
  return m[1];
};

// The environment inputs this harness pins to a value NO real host has, each
// with the reason it cannot be otherwise. The OpenAI seat's round-9 BLOCK is
// why this is an enumerated list with reasons rather than an implicit
// consequence of how `runShippedScript` happens to build its env: PATH was
// pinned to the stub directory, no cell had a real host's PATH, and
//
//   if [ "${PATH%%:*}" = "$WBS_ROOT/stubbin" ]; then <merge> fi
//
// was true in all 128 cells and false on every real host. That pin cannot be
// removed -- it is what makes the script runnable unprivileged and stoppable
// before it writes outside WBS_ROOT -- so it is a stated boundary instead.
//
// The reasons here are prose and only prose, for the same reason `EnvAxis.why`
// is: a string cannot be checked for truth, and asserting on its LENGTH is the
// vacuous check round 8 deleted (a reason of forty x's would pass it). What is
// executable is the SET, and it is enforced on the env the child process
// actually receives -- see `assertEveryNameAccountedFor`. A new pin is then an
// env axis carrying the shipped default, a BASE_ENV pin held to it, or a
// deliberate entry here. It cannot be none of them.
const PINNED_BY_CONSTRUCTION: Record<string, string> = {
  PATH: 'the stub directory must come first: it is what makes the script runnable unprivileged and stops it at htpasswd, before the one step that writes outside WBS_ROOT',
  WBS_ROOT:
    'a fresh /tmp directory this harness reads its results out of; it must never be a real /home/*/wbs',
};

// The part of the harness environment that is a fixed VALUE rather than a
// per-run path. Every key here that configure.sh gives a default must be
// pinned to that default -- see the guard case below for why.
const BASE_ENV: Record<string, string> = {
  WBS_USER: shippedDefault('WBS_USER'),
  BUN_VERSION: shippedDefault('BUN_VERSION'),
  REGISTRY_PASS: 'stopped-before-this-is-used',
};

// The names `ENV_AXES` varies, hoisted here because the rule below runs inside
// `runShippedScript` and `ENV_AXES` itself lives in the describe block with the
// argument that motivates it. The guard case holds the two in exact
// correspondence both ways, so this is a second spelling of one list rather
// than a second list: a name here with no axis fails, and an axis with no name
// here fails.
const ENV_AXIS_NAMES: readonly string[] = [
  'SITE_ADDRESS',
  'REGISTRY_INSECURE',
  'REGISTRY_HOST',
  'REGISTRY_USER',
  'REGISTRY_PASS',
  'WBS_USER',
  'BUN_VERSION',
];

// The round-9 rule, rebound to the object the child process actually receives.
// Sol's round-10 BLOCK is why it moved: round 9 compared the `byConstruction`
// LITERAL's keys against PINNED_BY_CONSTRUCTION, which says nothing about the
// env that literal is merged INTO, so a pin added one line further down --
//
//   Object.entries({ ...byConstruction, ...BASE_ENV, ...overrides,
//                    HARNESS_GATE: 'harness-only' })
//
// passed both round-9 checks, and `[ "${HARNESS_GATE:-}" = harness-only ]`
// would have been true in all 128 cells and false on every real host: the
// round-9 finding again, one line away from where it was closed. Reading the
// final env leaves no "one line further down" -- every name reaching
// configure.sh is a stated boundary pin, a BASE_ENV pin held to the shipped
// default, or an axis that varies, and a name that is none of those is a value
// no cell varies and no guard covers.
// `Object.hasOwn`, never `in`, and that is the whole of Sol's round-11 BLOCK:
// `'constructor' in PINNED_BY_CONSTRUCTION` is TRUE through Object.prototype,
// as are `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`,
// `propertyIsEnumerable`, `toLocaleString` and `__proto__` -- and every one of
// them is a legal shell variable name. So `constructor: 'harness-only'` in the
// env literal read as accounted-for, and `[ "${constructor:-}" = harness-only ]`
// was the round-10 mutation again, wearing an inherited key. The closed set was
// never closed; it just looked closed to `in`.
const assertEveryNameAccountedFor = (env: Record<string, string>): void => {
  const unaccounted = Object.keys(env).filter(
    (name) =>
      !Object.hasOwn(PINNED_BY_CONSTRUCTION, name) &&
      !Object.hasOwn(BASE_ENV, name) &&
      !ENV_AXIS_NAMES.includes(name),
  );
  if (unaccounted.length > 0) {
    throw new Error(
      `the harness hands configure.sh ${unaccounted.join()}, which is neither a stated PINNED_BY_CONSTRUCTION boundary, a BASE_ENV pin, nor an ENV_AXIS_NAMES axis; a name no cell varies is a value no real host has`,
    );
  }
  // The other direction, so the stated boundary cannot outlive the pin it
  // describes: an entry left behind after its pin was dropped would make this
  // file claim it proves less than it does.
  const stale = Object.keys(PINNED_BY_CONSTRUCTION).filter((name) => !Object.hasOwn(env, name));
  if (stale.length > 0) {
    throw new Error(
      `PINNED_BY_CONSTRUCTION names ${stale.join()} but the harness no longer pins it; a stated boundary with nothing behind it understates what this file proves`,
    );
  }
};

const LOG_MARKER = 'log() {';
const DIE_MARKER = 'die() {';
const MERGE_START = 'caddyfile="$WBS_ROOT/caddy/Caddyfile"';
const MERGE_END = 'chown "$WBS_USER:$WBS_USER" "$caddyfile"';

const helpersStart = configureSh.indexOf(LOG_MARKER);
const dieStart = configureSh.indexOf(DIE_MARKER);
if (helpersStart < 0 || dieStart < helpersStart) {
  throw new Error('configure.sh no longer defines log() then die() — update this harness');
}
// The real `die` too, not a stand-in: a `die` that stopped exiting non-zero is
// exactly the regression the read-error cases below are here to catch.
const helpers = configureSh.slice(helpersStart, configureSh.indexOf('\n', dieStart) + 1);
const mergeBlock = sliceOrThrow(MERGE_START, MERGE_END);

// `chown` needs root; the merge logic does not, and the tests run unprivileged.
// The grep wrapper exists because exit 2 — a read error rather than "no match"
// — cannot be provoked portably from the filesystem, and the two guards that
// distinguish 1 from 2 are the whole reason a partial Caddyfile cannot be
// installed over five live vhost imports. The wrapper counts through a file,
// not a variable: both greps run inside command substitutions, so a shell
// variable would be incremented in a subshell and lost.
const harness = `set -eu
WBS_ROOT="$1"
WBS_USER=wbs-test
chown() { :; }
if [ -n "\${FAIL_GREP_NTH:-}" ]; then
  __grep_counter="$WBS_ROOT/.grep-calls"
  printf '0' > "$__grep_counter"
  grep() {
    __n=$(cat "$__grep_counter")
    __n=$((__n + 1))
    printf '%s' "$__n" > "$__grep_counter"
    if [ "$__n" -eq "$FAIL_GREP_NTH" ]; then
      printf 'injected read failure\\n' >&2
      return 2
    fi
    command grep "$@"
  }
fi

${helpers}
${mergeBlock}
`;

// Sol's round-2 finding 1: slicing proves the block BEHAVES, not that
// configure.sh ever RUNS it. Wrap it in an uncalled `merge_caddyfile() { ... }`
// and every behavioural case stays green while the shipped script writes no
// Caddyfile at all.
//
// The first answer was a nesting-depth walk over the script text. Gemini's
// round 3 took it apart in three `sh -n`-clean lines -- `merge_caddyfile() {`
// with a trailing comment, the POSIX subshell form `merge_caddyfile() (`, and
// `false && {` -- and it was right: counting tokens cannot decide shell
// reachability, and a guard that reads sound while missing three one-line
// mutations is worse than none.
//
// So run it instead -- and run the WHOLE file, not a prefix of it. Sol's
// round-4 follow-up is why: a prefix ending at the merge block's last line
// cuts every wrapper mutation mid-construct, so `sh` refuses the file with
// exit 2 and the case goes red for "it no longer parses" rather than for "no
// Caddyfile was written". `expect(status).toBe(0)` cannot tell those apart,
// which made the earlier mutation kills worthless as reachability evidence.
//
// The whole shipped text always parses, mutated or not, so the only thing
// left that can differ is whether the block RAN. Execution is stopped
// deliberately and well past the block by a `htpasswd` stub that exits
// STOP_STATUS -- `set -e` then ends the script at a known line, before it can
// reach `mkdir -p /etc/docker` and rewrite the build host's real docker
// daemon config. Nothing is truncated to arrange that: the stop is a stubbed
// command's exit code, not a cut.
//
// So a mutation is now told from a break by three signals read together:
// identical exit status (the same stop, not an earlier error), site.caddy
// seeded (the block after the merge block still ran), and the Caddyfile
// present or absent (the only thing under test).
const STOP_STATUS = 7;

// dash refuses `apt-get() { ... }` -- POSIX function names cannot contain a
// hyphen -- so the stubs are executables on a shadowing PATH instead. Only the
// root- and network-bound commands are shadowed; mkdir, touch, cat, printf,
// grep and mv stay real, because those are what the block under test uses.
const STUBS: Record<string, string> = {
  id: '#!/bin/sh\ncase "${1:-}" in -u) echo 0 ;; *) exit 0 ;; esac\n',
  'apt-get': '#!/bin/sh\nexit 0\n',
  usermod: '#!/bin/sh\nexit 0\n',
  systemctl: '#!/bin/sh\nexit 1\n',
  curl: '#!/bin/sh\nexit 0\n',
  // Echoing the pinned version takes the script's already-installed branch, so
  // nothing tries to fetch bun.
  bun: '#!/bin/sh\necho "$BUN_VERSION"\n',
  chown: '#!/bin/sh\nexit 0\n',
  chmod: '#!/bin/sh\nexit 0\n',
  rm: '#!/bin/sh\nexit 0\n',
  // The deliberate stop. It sits AFTER the merge block and the site.caddy
  // seed, and BEFORE the /etc/docker converge -- the one part of this script
  // that writes outside WBS_ROOT and must never run on a build host.
  htpasswd: `#!/bin/sh\nexit ${String(STOP_STATUS)}\n`,
};

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// TASK-160, Sol round 7. `env` exists because environment is host state too,
// and the product above does not model any of it: every value below was a
// constant, so a wrapper reading one was true in all eight cells. `null`
// means UNSET rather than empty -- REGISTRY_INSECURE's documented pair is
// "unset" vs "1", and `REGISTRY_INSECURE=''` is a third thing that is neither.
const runShippedScript = (
  opts: {
    stubs?: Record<string, string>;
    mutate?: (text: string) => string;
    seedCaddyfile?: string;
    env?: Record<string, string | null>;
  } = {},
): {
  status: number | null;
  stderr: string;
  caddyfile: string | null;
  siteCaddy: string | null;
} => {
  const root = mkdtempSync(join(tmpdir(), 'task160-reach-'));
  if (opts.seedCaddyfile !== undefined) {
    // A host that has already been configured once. The script creates this
    // directory itself, well before the block under test; seeding it here just
    // puts the file there first.
    mkdirSync(join(root, 'caddy'), { recursive: true });
    writeFileSync(join(root, 'caddy', 'Caddyfile'), opts.seedCaddyfile);
  }
  const bin = join(root, 'stubbin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ ...STUBS, ...(opts.stubs ?? {}) })) {
    const f = join(bin, name);
    writeFileSync(f, body);
    chmodSync(f, 0o755);
  }
  const text = opts.mutate ? opts.mutate(configureSh) : configureSh;
  if (opts.mutate && text === configureSh) {
    throw new Error('a mutation that changed nothing would pass as a kill; check its markers');
  }
  const script = join(root, 'configure.sh');
  writeFileSync(script, text);
  const overrides = opts.env ?? {};
  // No construction pin is overridable, and this is the whole list rather than
  // WBS_ROOT alone -- Sol's round-10 note, that the old special case left PATH
  // overridable while PINNED_BY_CONSTRUCTION recorded it as fixed. Either name
  // going free is a value the file says cannot vary, varying. For WBS_ROOT it
  // is also where the results are read back from: a redirect would return
  // `caddyfile: null` and score the cell a kill for the wrong reason, the same
  // conflation the whole-script rewrite exists to remove.
  for (const [name, reason] of Object.entries(PINNED_BY_CONSTRUCTION)) {
    if (Object.hasOwn(overrides, name)) {
      throw new Error(`${name} is fixed by construction: ${reason}`);
    }
  }
  const env = Object.fromEntries(
    Object.entries<string | null>({
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      WBS_ROOT: root,
      ...BASE_ENV,
      ...overrides,
    }).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  // On every run, against the finished object, not against any literal that
  // fed it.
  assertEveryNameAccountedFor(env);
  const res = spawnSync('/bin/sh', [script], { encoding: 'utf8', env });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stderr: res.stderr,
    caddyfile: readOrNull(join(root, 'caddy', 'Caddyfile')),
    siteCaddy: readOrNull(join(root, 'caddy', 'site.caddy')),
  };
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  caddyfile: string;
}

const runMerge = (
  existing: string | null,
  opts: { failGrepNth?: number; mode?: number } = {},
): Run => {
  const root = mkdtempSync(join(tmpdir(), 'task160-caddy-'));
  mkdirSync(join(root, 'caddy'));
  const caddyfile = join(root, 'caddy', 'Caddyfile');
  if (existing !== null) {
    writeFileSync(caddyfile, existing);
    if (opts.mode !== undefined) chmodSync(caddyfile, opts.mode);
  }
  const script = join(root, 'merge.sh');
  writeFileSync(script, harness);
  const res = spawnSync('/bin/sh', [script, root], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(opts.failGrepNth ? { FAIL_GREP_NTH: String(opts.failGrepNth) } : {}),
    },
  });
  if (opts.mode !== undefined) chmodSync(caddyfile, 0o644);
  let written = '';
  try {
    written = readFileSync(caddyfile, 'utf8');
  } catch {
    written = '';
  }
  // A spawn that never started reports status null and empty streams, which
  // would read as a silent pass on the die cases; surface it as a failure here
  // rather than letting a case assert on nothing.
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, caddyfile: written };
};

const importsOf = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('import '));

const OWNED = ['import log-redact.caddy', 'import site.caddy'];
const RUNNING_AS_ROOT = process.getuid() === 0;

describe('configure.sh Caddyfile merge, executed', () => {
  it('slices the shipped block rather than a copy of it', () => {
    // If this ever passes while the block above is empty or truncated, every
    // other case in this file is asserting on nothing.
    expect(mergeBlock).toContain('refusing to rewrite it');
    expect(mergeBlock).toContain('exists but is not readable');
    expect(mergeBlock).toContain('mv "$caddy_tmp" "$caddyfile"');
    expect(helpers).toContain('exit 1');
    expect(mergeBlock.split('\n').length).toBeGreaterThan(20);
  });

  // Sol round 4, generalised in round 5: a stub with ONE fixed outcome pins one
  // branch of the shipped script, and a mutation that wraps the merge block in
  // THAT condition survives every assertion here while skipping the merge on a
  // real host. `if ! systemctl list-unit-files caddy.service; then <merge> fi`
  // was the first instance; Sol found the second (`bun --version`), and the
  // same shape gives a third (a Caddyfile that already exists). So the control
  // runs the whole matrix of host state the script reads before the block,
  // and each conditional mutation below is paired with the state that exposes
  // it. Adding a branch to configure.sh means adding a dimension here.
  const PRESERVED = 'import monitoring.caddy';
  interface HostState {
    key: string;
    stubs?: Record<string, string>;
    seedCaddyfile?: string;
  }
  // Sol round 6, and right a fifth time: six one-factor-at-a-time rows are not
  // a matrix. They cover only four distinct states, and this survives all of
  // them --
  //
  //   if [ "$current_bun_version" = "$BUN_VERSION" ] \
  //      || [ ! -e "$WBS_ROOT/caddy/Caddyfile" ]; then <merge> fi
  //
  // -- because bun is pinned in the row that seeds a Caddyfile and no
  // Caddyfile is seeded in the row that unpins bun, so the disjunction is
  // true in every row and false only on the COMBINED state: a host configured
  // once before whose bun has since drifted. That is a real host, and it is
  // exactly the re-run these imports have to survive.
  //
  // So take the product, not the rows. Every boolean function of these three
  // predicates is false in at least one of the eight cells unless it is a
  // tautology over them -- and a tautology always runs the block, which is
  // the outcome being asked for anyway.
  //
  // `bun --version` empty (not installed) and mismatched are ONE branch: the
  // script compares for equality against $BUN_VERSION, so one stub covers
  // both. Adding a branch to configure.sh means adding a dimension here.
  const DIMENSIONS = [
    [
      ['no host caddy unit', { stubs: { systemctl: '#!/bin/sh\nexit 1\n' } }],
      ['a host caddy unit', { stubs: { systemctl: '#!/bin/sh\nexit 0\n' } }],
    ],
    [
      ['pinned bun installed', {}],
      ['bun missing or a different version', { stubs: { bun: '#!/bin/sh\nexit 127\n' } }],
    ],
    [
      ['no Caddyfile yet', {}],
      ['a Caddyfile from an earlier run', { seedCaddyfile: `${PRESERVED}\n` }],
    ],
  ] as const satisfies readonly (readonly (readonly [string, Partial<HostState>])[])[];

  const HOST_STATES: readonly HostState[] = DIMENSIONS.reduce<HostState[]>(
    (acc, dimension) =>
      acc.flatMap((partial) =>
        dimension.map(([label, delta]) => ({
          ...partial,
          ...delta,
          key: partial.key === '' ? label : `${partial.key}, ${label}`,
          stubs: { ...partial.stubs, ...('stubs' in delta ? delta.stubs : {}) },
        })),
      ),
    [{ key: '' }],
  );

  it('takes the product of the host-state dimensions, not one factor at a time', () => {
    // The guard on the comment above. If a dimension is added and this falls
    // back to a sum, a mutation conditioned on two of them goes unseen again.
    expect(HOST_STATES).toHaveLength(DIMENSIONS.reduce((n, dimension) => n * dimension.length, 1));
    expect(new Set(HOST_STATES.map((state) => state.key)).size).toBe(HOST_STATES.length);
  });

  for (const state of HOST_STATES) {
    it(`is reached by the shipped script, not merely runnable in isolation (${state.key})`, () => {
      const run = runShippedScript(state);
      // The stop is the htpasswd stub, so the script ran PAST the merge block
      // and past the site.caddy seed to get here. Asserting the status pins
      // where it stopped: any earlier failure carries a different one.
      expect(run.status).toBe(STOP_STATUS);
      expect(run.stderr).toBe('');
      expect(run.siteCaddy).not.toBeNull();
      expect(run.caddyfile).not.toBeNull();
      expect(importsOf(run.caddyfile ?? '')).toEqual(
        state.seedCaddyfile === undefined ? OWNED : [...OWNED, PRESERVED],
      );
    });
  }

  it('runs the whole shipped file, and stops where this harness says it does', () => {
    // Nothing is sliced for the reachability cases -- if it were, a wrapper
    // mutation would fail on a syntax error and be scored as a kill. The stop
    // must also stay ordered: after the block under test, before the only
    // step that writes outside WBS_ROOT.
    const at = (needle: string): number => {
      const i = configureSh.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(configureSh).toContain('must run as root');
    expect(configureSh).toContain('(access-log) {');
    expect(at(MERGE_END)).toBeLessThan(at('htpasswd -Bbn'));
    expect(at('htpasswd -Bbn')).toBeLessThan(at('mkdir -p /etc/docker'));
  });

  // Sol's round-4 point, answered as executable cases rather than as watched
  // one-off runs. Each mutation leaves the merge block byte-identical and
  // only disconnects it from control flow -- so every behavioural case above
  // still passes, and only these can see it. All three were `sh -n` clean
  // against the earlier text-walking guard, which is why that guard is gone.
  const WRAPPERS: readonly (readonly [string, (b: string) => string])[] = [
    ['an uncalled function', (b) => `merge_caddyfile() {\n${b}\n}\n`],
    // Gemini round 3: a trailing comment after `{` and the POSIX subshell
    // form both defeat "does the line end in a brace".
    [
      'an uncalled function whose brace carries a comment',
      (b) => `merge_caddyfile() { # merge\n${b}\n}\n`,
    ],
    ['an uncalled POSIX subshell function', (b) => `merge_caddyfile() (\n${b}\n)\n`],
    ['a short-circuited group', (b) => `false && {\n${b}\n}\n`],
    ['an if that never fires', (b) => `if false; then\n${b}\nfi\n`],
  ];

  for (const [label, wrap] of WRAPPERS) {
    it(`writes no Caddyfile when the block is disconnected by ${label}`, () => {
      const run = runShippedScript({
        // A function replacer, not a string: `$$` and `$&` in a string
        // replacement are substitution syntax, and the block is full of
        // `$$` (`$caddyfile.tmp.$$`), which would silently corrupt it into a
        // different mutation than the one named.
        mutate: (text) => text.replace(mergeBlock, () => wrap(mergeBlock)),
      });
      // Same stop and the same downstream file as the control run: the script
      // parsed, ran, and got exactly as far. The ONLY difference is the
      // Caddyfile, which is what makes this a reachability result and not a
      // restatement of "the mutated file is broken".
      expect(run.status).toBe(STOP_STATUS);
      expect(run.stderr).toBe('');
      expect(run.siteCaddy).not.toBeNull();
      expect(run.caddyfile).toBeNull();
    });
  }

  // The wrappers above disconnect the block unconditionally, so any host state
  // kills them. These do not: each is a condition the shipped script itself
  // reads, and each is TRUE on some hosts and false on others -- so each one
  // passes every behavioural case and is caught only by the cell of the
  // product where its condition goes false. Rather than hand-pick that cell
  // (which is how round 6's disjunction slipped through -- the pick was made
  // per-mutation, one factor at a time), every mutation runs the WHOLE
  // product and the assertions are about the shape of the result.
  const CONDITIONALS: readonly (readonly [string, (b: string) => string])[] = [
    [
      'a condition on the host caddy unit',
      (b) => `if ! systemctl list-unit-files caddy.service >/dev/null 2>&1; then\n${b}\nfi\n`,
    ],
    [
      // Sol, round 5.
      'a condition on the installed bun version',
      (b) => `if [ "$current_bun_version" = "$BUN_VERSION" ]; then\n${b}\nfi\n`,
    ],
    [
      // The literal path, not "$caddyfile": that variable is assigned by the
      // block's own first line, so a wrapper referencing it would die on
      // `set -u` at status 2 and be scored as a kill for the wrong reason --
      // the exact conflation this rewrite exists to remove. This is also the
      // worst of the three, because "only write it if there isn't one" skips
      // precisely the re-run that has five live vhost imports to preserve.
      'a condition on the Caddyfile not already existing',
      (b) => `if [ ! -e "$WBS_ROOT/caddy/Caddyfile" ]; then\n${b}\nfi\n`,
    ],
    [
      // Sol, round 6: false only where two dimensions go the wrong way at
      // once. It is here so the product has to keep being a product.
      'a condition spanning two host-state dimensions',
      (b) =>
        `if [ "$current_bun_version" = "$BUN_VERSION" ] || [ ! -e "$WBS_ROOT/caddy/Caddyfile" ]; then\n${b}\nfi\n`,
    ],
  ];

  const wroteOwned = (run: { caddyfile: string | null }): boolean =>
    importsOf(run.caddyfile ?? '').includes('import log-redact.caddy');

  for (const [label, wrap] of CONDITIONALS) {
    it(`is caught somewhere in the product when disconnected by ${label}`, () => {
      const runs = HOST_STATES.map((state) => ({
        key: state.key,
        run: runShippedScript({
          ...state,
          mutate: (text) => text.replace(mergeBlock, () => wrap(mergeBlock)),
        }),
      }));

      // No cell may BREAK. Every one reaches the same stop having seeded
      // site.caddy, so the only thing that varies across the product is
      // whether the block ran -- which is what makes the counts below a
      // reachability result.
      for (const { key, run } of runs) {
        expect(`${key}: status ${String(run.status)}`).toBe(
          `${key}: status ${String(STOP_STATUS)}`,
        );
        expect(`${key}: ${run.stderr}`).toBe(`${key}: `);
        expect(run.siteCaddy).not.toBeNull();
      }

      const killed = runs.filter(({ run }) => !wroteOwned(run)).map(({ key }) => key);
      const hidden = runs.filter(({ run }) => wroteOwned(run)).map(({ key }) => key);
      // Caught somewhere: the product sees it at all.
      expect(killed.length).toBeGreaterThan(0);
      // Hidden somewhere: it is a CONDITIONAL disconnect, not a blanket one,
      // so a single hand-picked state would have missed it and the product is
      // doing the work. This is also what stops a no-op mutation scoring as a
      // kill -- a no-op writes the imports in every cell and empties `killed`.
      expect(hidden.length).toBeGreaterThan(0);
    });
  }

  // ---------------------------------------------------------------------
  // Sol round 7, and right a sixth time. The tautology argument above is
  // sound FOR THE THREE PREDICATES IN `DIMENSIONS`, and that is exactly its
  // limit: `runShippedScript` pinned every environment input to one value, so
  //
  //   if [ "$SITE_ADDRESS" = "wbs.bulletpoints.club" ]; then <merge> fi
  //
  // is true in all eight cells and false on a host started the way the module
  // docstring documents -- `SITE_ADDRESS=":80"`, for a box whose DNS does not
  // exist yet (configure.sh:39). Environment is host state too.
  //
  // Adding a `SITE_ADDRESS` row would be the fourth time this finding is
  // patched at the instance it was named at. So the claim here is about the
  // SHAPE instead: the merge block's reachability condition is the EMPTY
  // CONJUNCTION over the environment -- no env input is a discriminator at
  // all -- and every input the script reads gets an axis rather than a row.
  interface EnvAxis {
    readonly name: string;
    readonly alternative: Record<string, string | null>;
    // Prose, and only prose: the OpenAI seat's round-8 note is that asserting
    // on its LENGTH proved nothing about the value. The value is checked by
    // 'gives every environment axis a value a real host actually has'.
    readonly why: string;
  }
  // Every environment input configure.sh reads (lines 34-55, plus the required
  // REGISTRY_PASS at line 61). `WBS_ROOT` is the eighth and is deliberately
  // absent: see the throw in `runShippedScript`.
  const ENV_AXES: readonly EnvAxis[] = [
    {
      name: 'SITE_ADDRESS',
      alternative: { SITE_ADDRESS: ':80' },
      why: 'the documented ":80" form, for a host whose DNS does not exist yet (configure.sh:39)',
    },
    {
      name: 'REGISTRY_INSECURE',
      alternative: { REGISTRY_INSECURE: '1' },
      why: 'documented as =1 for a registry with no TLS in front of it; the default is unset',
    },
    {
      name: 'REGISTRY_HOST',
      alternative: { REGISTRY_HOST: 'registry.example.invalid:5000' },
      why: 'documented override; defaults to the public hostname Caddy terminates TLS for',
    },
    {
      name: 'REGISTRY_USER',
      alternative: { REGISTRY_USER: 'someone-else' },
      why: 'set explicitly in the documented usage line',
    },
    {
      name: 'REGISTRY_PASS',
      alternative: { REGISTRY_PASS: 'a-different-secret' },
      why: 'required, so `[ -n "$REGISTRY_PASS" ]` is a tautology past configure.sh:61 -- but its VALUE is free, and an equality on it would not be',
    },
    {
      name: 'WBS_USER',
      alternative: { WBS_USER: 'wbs-test' },
      why: 'the deploy user; the docstring passes it explicitly (configure.sh:16) and the default is what the real host runs',
    },
    {
      name: 'BUN_VERSION',
      alternative: { BUN_VERSION: '1.2.20' },
      why: 'the version already on h2puni before the pin existed (configure.sh:47-55)',
    },
  ];

  // Gemini round 8's finding, as a permanent rule rather than as two patched
  // values. An axis is only worth anything if one of its two values is the one
  // a real host has -- otherwise `!= <the real value>` is true in every cell.
  // Two ways an input gets there, and both are checked below:
  //   - the harness never sets it, so configure.sh's own default applies; or
  //   - the harness sets it TO configure.sh's default, read out of the script.
  // REGISTRY_PASS is the one input with no shipped default and no possible
  // one: configure.sh:61 dies without it, and its real value is a secret. So
  // `case "$REGISTRY_PASS" in stopped-*)` survives this file -- named here
  // because the boundary is the point, not the omission.
  const NO_SHIPPED_DEFAULT = ['REGISTRY_PASS'];

  it('gives every environment axis a value a real host actually has', () => {
    const wrong: string[] = [];
    // The rule, applied to the pins rather than to the two values Gemini
    // happened to name: anything this harness pins to a fixed value must be
    // pinned to configure.sh's own default, read out of the script. A future
    // pin added without that is the same hole again.
    // Nothing may be pinned by construction and an axis at the same time: an
    // axis would look varied while the harness overwrote it back to one value.
    for (const axis of ENV_AXES) {
      if (Object.hasOwn(PINNED_BY_CONSTRUCTION, axis.name)) {
        wrong.push(`${axis.name}: pinned by construction, so it cannot also be an axis`);
      }
    }
    // ENV_AXIS_NAMES is what `assertEveryNameAccountedFor` reads, and it is one
    // list only while these two agree exactly. A name added there to silence a
    // smuggled pin has no axis and fails here; an axis added here without the
    // name fails at the first cell that runs.
    const declared = [...ENV_AXIS_NAMES].sort().join();
    const actual = ENV_AXES.map((axis) => axis.name)
      .sort()
      .join();
    if (declared !== actual) {
      wrong.push(`ENV_AXIS_NAMES is ${declared} but ENV_AXES is ${actual}`);
    }
    // An alternative that set a SECOND name would put that name in every cell
    // of the half where the axis is taken, unvaried and unaccounted for -- the
    // round-10 smuggling route with an axis in front of it.
    for (const axis of ENV_AXES) {
      const keys = Object.keys(axis.alternative);
      if (keys.length !== 1 || keys[0] !== axis.name) {
        wrong.push(`${axis.name}: its alternative must set its own name and nothing else`);
      }
    }
    for (const [name, pinned] of Object.entries(BASE_ENV)) {
      if (NO_SHIPPED_DEFAULT.includes(name)) continue;
      const shipped = shippedDefault(name);
      if (pinned !== shipped) {
        wrong.push(`${name}: harness pins ${pinned}, configure.sh defaults to ${shipped}`);
      }
    }
    for (const axis of ENV_AXES) {
      if (!Object.hasOwn(axis.alternative, axis.name)) {
        wrong.push(`${axis.name}: its alternative must set its own name`);
        continue;
      }
      const alternative = axis.alternative[axis.name];
      if (alternative === null) {
        // `null` is UNSET, which for an input with a default is the default
        // again -- a no-op axis wearing the shape of a real one.
        wrong.push(`${axis.name}: unsetting it is not an alternative, it is the default`);
        continue;
      }
      if (NO_SHIPPED_DEFAULT.includes(axis.name)) continue;
      // The default cell is either untouched by the harness -- so
      // configure.sh's default applies by construction -- or pinned to that
      // default by the loop above. Either way the alternative must differ, or
      // the axis is a no-op that would still satisfy the sweeps.
      if (alternative === shippedDefault(axis.name)) {
        wrong.push(`${axis.name}: its alternative equals the shipped default`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // The regression case for Sol's round-11 BLOCK, executable rather than
  // argued. Every name here is inherited from Object.prototype, so `in` says
  // the closed set contains it, and every one is a legal shell variable name --
  // `[ "${constructor:-}" = harness-only ]` would have been true in all 128
  // cells and false on every real host. `Object.hasOwn` is what makes the set
  // closed; this case is what makes a future `in` fail loudly instead of
  // quietly widening it again.
  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`refuses ${inherited}, which is inherited rather than in the closed set`, () => {
      expect(() => runShippedScript({ env: { [inherited]: 'harness-only' } })).toThrow(
        /neither a stated PINNED_BY_CONSTRUCTION boundary/,
      );
    });
  }

  // Enumerated in binary, so cell i takes axis k's alternative exactly when
  // bit k of i is set. That is the full product -- all 2^7 combinations, not
  // one factor at a time -- and it is what makes the two properties below
  // provable rather than hopeful.
  //
  // Each cell also runs at a host state, and WHICH one is not `i % 8`. That
  // was the first attempt and the guard below caught it: the low three bits
  // of `i` are axes 0-2, so `i % 8` made those three axes a FUNCTION of the
  // host state and 26 of the 112 (axis value, host state) pairs never
  // occurred. Instead the host index is a weighted sum over the set axes with
  // the weights cycling 1, 2, 4. Fixing any single axis leaves six free ones,
  // and each weight class still has a member (weight 1: axes 0/3/6, weight 2:
  // axes 1/4, weight 4: axes 2/5), so the remaining sum still reaches all
  // eight residues -- every pair occurs, by construction and not by luck.
  //
  // Why pairs are the thing being bought: round 6's finding was a condition
  // false only where two dimensions go the wrong way at once. This is that
  // same shape reaching across the two groups, and the pairing closes it
  // without the 1024-cell joint product.
  //
  // The boundary, stated rather than left to be inferred. Uncovered here:
  // a condition needing TWO env axes AND a host-state dimension to align at
  // once, and any property shared by every value this harness can give a
  // pin it cannot vary -- the entries of PINNED_BY_CONSTRUCTION. So
  // `case "$WBS_ROOT" in /tmp/*)` and `[ "${PATH%%:*}" = "$WBS_ROOT/stubbin" ]`
  // both survive this file. Neither pin can be dropped: one is where the
  // results are read from, the other is what stops the script before it writes
  // outside WBS_ROOT. What the list buys is that the set is CLOSED, and after
  // round 10 that is a claim about the env configure.sh actually receives
  // rather than about one literal on the way to it: every name in it is a
  // boundary pin, a BASE_ENV pin at the shipped default, or an axis
  // (`assertEveryNameAccountedFor`), so a new pin cannot join silently from
  // anywhere -- not the merge literal, not an axis's alternative, not an
  // override, and not through Object.prototype, which is what round 11 found
  // and what `Object.hasOwn` closes.
  const HOST_WEIGHTS = [1, 2, 4] as const;
  const hostIndexFor = (picks: readonly boolean[]): number =>
    picks.reduce(
      (sum, pick, bit) => (pick ? sum + HOST_WEIGHTS[bit % HOST_WEIGHTS.length] : sum),
      0,
    ) % HOST_STATES.length;

  interface EnvCell {
    readonly key: string;
    readonly picks: readonly boolean[];
    readonly env: Record<string, string | null>;
    readonly host: HostState;
  }
  const ENV_CELLS: readonly EnvCell[] = Array.from(
    { length: 2 ** ENV_AXES.length },
    (_unused, i): EnvCell => {
      const picks = ENV_AXES.map((_axis, bit) => ((i >> bit) & 1) === 1);
      const env = ENV_AXES.reduce<Record<string, string | null>>(
        (acc, axis, bit) => (picks[bit] ? { ...acc, ...axis.alternative } : acc),
        {},
      );
      const host = HOST_STATES[hostIndexFor(picks)];
      const alt = ENV_AXES.filter((_axis, bit) => picks[bit]).map((axis) => axis.name);
      return {
        key: `${alt.length === 0 ? 'all env defaults' : `alt: ${alt.join('+')}`} @ ${host.key}`,
        picks,
        env,
        host,
      };
    },
  );

  it('takes the product of the environment axes, and pairs every axis value with every host state', () => {
    expect(ENV_CELLS).toHaveLength(2 ** ENV_AXES.length);
    expect(new Set(ENV_CELLS.map((cell) => cell.key)).size).toBe(ENV_CELLS.length);
    // The pairing property, checked rather than asserted in a comment -- it
    // already caught one wrong mapping. If an axis is added or the weights
    // stop covering all three classes, this names the missing pairs instead
    // of quietly narrowing the sweep.
    expect(HOST_STATES.length).toBe(HOST_WEIGHTS.reduce((n, w) => n + w, 0) + 1);
    const missing: string[] = [];
    for (const [bit, axis] of ENV_AXES.entries()) {
      for (const pick of [false, true]) {
        for (const host of HOST_STATES) {
          const covered = ENV_CELLS.some(
            (cell) => cell.picks[bit] === pick && cell.host.key === host.key,
          );
          if (!covered) missing.push(`${axis.name}=${pick ? 'alt' : 'default'} @ ${host.key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('runs the merge block at every point of the environment product', () => {
    const failures: string[] = [];
    for (const cell of ENV_CELLS) {
      const run = runShippedScript({ ...cell.host, env: cell.env });
      const expected = cell.host.seedCaddyfile === undefined ? OWNED : [...OWNED, PRESERVED];
      const actual = {
        status: run.status,
        stderr: run.stderr,
        siteCaddy: run.siteCaddy === null ? 'missing' : 'seeded',
        imports: importsOf(run.caddyfile ?? ''),
      };
      const want = { status: STOP_STATUS, stderr: '', siteCaddy: 'seeded', imports: expected };
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        failures.push(`${cell.key}: ${JSON.stringify(actual)} != ${JSON.stringify(want)}`);
      }
    }
    // The empty conjunction, as a result: no point of the product skips the
    // block, so nothing in the environment is part of its guard.
    expect(failures).toEqual([]);
  }, 60_000);

  // Round 7's own condition, kept as a permanent case. It is invisible to the
  // host-state sweep above -- SITE_ADDRESS is constant there, so `killed`
  // would be 0 and that test would fail for the wrong reason -- which is
  // precisely why the environment needed a product of its own.
  const ENV_CONDITIONALS: readonly (readonly [string, (b: string) => string])[] = [
    [
      'a condition on the configured site address',
      (b) => `if [ "$SITE_ADDRESS" = "wbs.bulletpoints.club" ]; then\n${b}\nfi\n`,
    ],
    [
      // The cross-group version of round 6: one env axis and one host-state
      // dimension, false only where both go the wrong way. The pairing
      // property is what sees it.
      'a condition spanning the environment and the host state',
      (b) =>
        `if [ "$SITE_ADDRESS" = "wbs.bulletpoints.club" ] || [ ! -e "$WBS_ROOT/caddy/Caddyfile" ]; then\n${b}\nfi\n`,
    ],
  ];

  for (const [label, wrap] of ENV_CONDITIONALS) {
    it(`is caught somewhere in the environment product when disconnected by ${label}`, () => {
      const broken: string[] = [];
      const killed: string[] = [];
      const hidden: string[] = [];
      for (const cell of ENV_CELLS) {
        const run = runShippedScript({
          ...cell.host,
          env: cell.env,
          mutate: (text) => text.replace(mergeBlock, () => wrap(mergeBlock)),
        });
        if (run.status !== STOP_STATUS || run.stderr !== '' || run.siteCaddy === null) {
          broken.push(`${cell.key}: status ${String(run.status)} stderr ${run.stderr}`);
        } else if (wroteOwned(run)) hidden.push(cell.key);
        else killed.push(cell.key);
      }
      // Same three signals as the host-state sweep: no cell may BREAK, so the
      // only thing varying across the product is whether the block ran.
      expect(broken).toEqual([]);
      expect(killed.length).toBeGreaterThan(0);
      expect(hidden.length).toBeGreaterThan(0);
    }, 60_000);
  }

  it('writes both owned imports, in order, when no Caddyfile exists', () => {
    const run = runMerge(null);
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual(OWNED);
  });

  it('writes both owned imports when the Caddyfile is empty', () => {
    const run = runMerge('');
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual(OWNED);
  });

  it('preserves every import it does not own', () => {
    // The five hand-added vhosts. A single-line overwrite takes all of them
    // down on the next re-run, which is what this whole block exists to stop.
    const existing = [
      'import registry.caddy',
      '  import monitoring.caddy',
      'import site-dev.caddy',
      'import novel.caddy',
      '\timport studio.caddy',
      '',
    ].join('\n');
    const run = runMerge(existing);
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual([
      ...OWNED,
      'import registry.caddy',
      'import monitoring.caddy',
      'import site-dev.caddy',
      'import novel.caddy',
      'import studio.caddy',
    ]);
  });

  it('does not duplicate an owned import that is already there', () => {
    // Caddy rejects a file that imports the same site definition twice as
    // ambiguous, and refuses the whole config — every vhost, not just this one.
    const run = runMerge('import log-redact.caddy\nimport site.caddy\nimport registry.caddy\n');
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual([...OWNED, 'import registry.caddy']);
  });

  it('keeps an unowned import whose name merely starts with an owned one', () => {
    // Gemini's round-2 finding 1, and a gap my own mutations missed: I dropped
    // the trailing-comment tolerance but kept the `$`, and dropping the anchor
    // ITSELF is the mutation that survives. All five real vhost names are
    // distinct enough from `site.caddy` to hide it; `site.caddy.backup` is not.
    const run = runMerge(
      'import site.caddy.backup\nimport log-redact.caddy.old\nimport site.caddy\n',
    );
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual([
      ...OWNED,
      'import site.caddy.backup',
      'import log-redact.caddy.old',
    ]);
  });

  it('emits nothing extra when every import it found was its own', () => {
    // Gemini's round-2 finding 2. `[ -z "$caddy_others" ] ||` guards a
    // `printf '%s\n' ""`, which drops a blank line into the middle of the
    // file. Harmless to Caddy, invisible to importsOf, and the only case where
    // that branch runs with nothing to print -- so this one asserts the exact
    // bytes instead of the import lines.
    const run = runMerge('import log-redact.caddy\nimport site.caddy\n');
    expect(run.status).toBe(0);
    expect(run.caddyfile).toBe('import log-redact.caddy\nimport site.caddy\n');
  });

  it('does not duplicate an owned import carrying a trailing comment', () => {
    const run = runMerge(
      'import site.caddy # rendered per-deploy\n\timport log-redact.caddy   # the access-log snippet\nimport registry.caddy\n',
    );
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual([...OWNED, 'import registry.caddy']);
  });

  it('recognises an owned import whatever it is indented with', () => {
    const run = runMerge('  import site.caddy\n\t import log-redact.caddy\n');
    expect(run.status).toBe(0);
    expect(importsOf(run.caddyfile)).toEqual(OWNED);
  });

  // Root reads a 0000 file, so this case is not constructible as root and is
  // skipped there rather than passing on nothing. The guard line itself is
  // still asserted unconditionally by the slice test above, so a root-only
  // runner loses the behaviour check but not the presence check.
  it.skipIf(RUNNING_AS_ROOT)(
    'refuses to rewrite a Caddyfile it cannot read, and leaves it alone',
    () => {
      const original = 'import registry.caddy\nimport monitoring.caddy\n';
      const run = runMerge(original, { mode: 0o000 });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('is not readable');
      expect(run.caddyfile).toBe(original);
    },
  );

  it('refuses to rewrite when reading the imports errors, and leaves it alone', () => {
    const original = 'import registry.caddy\nimport monitoring.caddy\n';
    const run = runMerge(original, { failGrepNth: 1 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('could not read');
    expect(run.caddyfile).toBe(original);
  });

  it('refuses to rewrite when filtering the imports errors, and leaves it alone', () => {
    // The second grep, the one that used to end in `|| true`. Exit 2 there
    // arrived as "every import was ours" and installed a two-line Caddyfile
    // over the five that were not.
    const original = 'import registry.caddy\nimport monitoring.caddy\n';
    const run = runMerge(original, { failGrepNth: 2 });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('could not filter');
    expect(run.caddyfile).toBe(original);
  });

  it('carries import lines only, dropping any other content', () => {
    // Characterization, not endorsement: the Caddyfile on this host holds
    // imports and comments about them, and a re-run keeps the imports and
    // drops the comments. Pinned so that changing it has to be a decision.
    const run = runMerge('# the registry vhost, added by hand 2026-08-02\nimport registry.caddy\n');
    expect(run.status).toBe(0);
    expect(run.caddyfile).toBe(
      'import log-redact.caddy\nimport site.caddy\nimport registry.caddy\n',
    );
  });
});
