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
// So run it instead. This executes the SHIPPED script from line 1 down to the
// end of the merge block, with only the root- and network-bound commands
// stubbed, and asserts a Caddyfile appears. Every mutation above disconnects
// the block from that control flow, so none of them writes one.
const scriptPrefix = configureSh.slice(0, configureSh.indexOf(MERGE_END) + MERGE_END.length);

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
};

const runShippedPrefix = (
  overrides: Record<string, string> = {},
): {
  status: number | null;
  stderr: string;
  caddyfile: string | null;
} => {
  const root = mkdtempSync(join(tmpdir(), 'task160-reach-'));
  const bin = join(root, 'stubbin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ ...STUBS, ...overrides })) {
    const f = join(bin, name);
    writeFileSync(f, body);
    chmodSync(f, 0o755);
  }
  const script = join(root, 'prefix.sh');
  writeFileSync(script, scriptPrefix + '\n');
  const res = spawnSync('/bin/sh', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      WBS_ROOT: root,
      WBS_USER: 'wbs-test',
      BUN_VERSION: 'stubbed',
      REGISTRY_PASS: 'unused-by-this-prefix',
    },
  });
  if (res.error) throw res.error;
  let caddyfile: string | null = null;
  try {
    caddyfile = readFileSync(join(root, 'caddy', 'Caddyfile'), 'utf8');
  } catch {
    caddyfile = null;
  }
  return { status: res.status, stderr: res.stderr, caddyfile };
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

  // Sol round 4: a stub with ONE fixed outcome pins one branch of the shipped
  // script. `if ! systemctl list-unit-files caddy.service; then <merge> fi` is
  // `sh -n` clean, passes here because the stub always exits 1, and skips the
  // merge entirely on a host that does have that unit. So the proof runs under
  // both outcomes of the one stubbed command the script branches on.
  for (const [label, exitCode] of [
    ['no host caddy unit', 1],
    ['a host caddy unit already present', 0],
  ] as const) {
    it(`is reached by the shipped script, not merely runnable in isolation (${label})`, () => {
      // KNOWN LIMIT, stated because it is not what it looks like. This runs a
      // PREFIX of the script, ending at the merge block's last line. Any
      // wrapper around the block must close AFTER that line, so the prefix
      // ends mid-construct and `sh` exits 2 on a syntax error. Every wrapper
      // mutation is therefore caught -- but by "the prefix no longer parses",
      // not by "no Caddyfile was written", and `status` conflates the two.
      // The proof that would not conflate them runs the WHOLE script; that
      // needs the compose/registry/docker-login tail stubbed too. Until then
      // this is a reachability SMOKE test, not the reachability proof.
      const run = runShippedPrefix({ systemctl: `#!/bin/sh\nexit ${exitCode}\n` });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.caddyfile).not.toBeNull();
      expect(importsOf(run.caddyfile ?? '')).toEqual(OWNED);
    });
  }

  it('runs the shipped prefix, not a fragment of it', () => {
    // A prefix that stopped short would write no Caddyfile for the honest
    // reason and the case above would read as a real failure; a prefix that
    // never reached the root checks would prove nothing about the real script.
    expect(scriptPrefix).toContain('must run as root');
    expect(scriptPrefix).toContain('(access-log) {');
    expect(scriptPrefix.trimEnd().endsWith(MERGE_END)).toBe(true);
  });

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
