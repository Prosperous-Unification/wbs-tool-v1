import { mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, '../../../bin/with-heavy-lock.sh');
const LOCK_LIB = join(import.meta.dir, '../../../bin/heavy-lock-lib.sh');
const roots: string[] = [];

// A file that is not there yet reads as empty rather than throwing, because
// every caller below is polling for it to appear.
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Polls a condition instead of sleeping a guessed interval. The rejection is
// what keeps a broken run honest: a case that stops observing what it waited for
// is a case that has to say so, rather than continuing on an assumption.
async function until(ready: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`condition not observed within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

// **Every contender states its own wait budget rather than inheriting one.**
//
// The two `Bun.spawn` lock HOLDERS below deliberately still inherit it, and that
// is safe for a reason worth stating rather than assuming: each holder is the
// first claimant of its own `mkdtemp` lock, so it never reaches the wait loop at
// all, and a child's environment cannot reach its sibling contender.
//
// `heavy-lock-lib.sh` reads `HEAVY_LOCK_WAIT_SECONDS` from the environment
// (`${HEAVY_LOCK_WAIT_SECONDS:-0}`), and `bin/h2puni-gate.sh` exports nothing —
// so the value every lane is told to launch the gate with,
// `HEAVY_LOCK_WAIT_SECONDS=900 ./bin/h2puni-gate.sh`, was inherited by this file
// through the gate's child processes. The refusal case below asserts *immediate*
// refusal, so under the documented recipe it queued for 900 seconds instead and
// died on its own timeout — a false red on a target unrelated to whatever was
// being gated, that read to the next lane exactly like a regression.
//
// Passing the value explicitly is not merely a fix for that: the wait budget is
// half of what these cases are about, so a case that reads it from whoever
// launched the runner is a case asserting a contract it does not control.
function runWithTestLock(lock: string, waitSeconds: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      'bash',
      '-c',
      'source "$1"; shift; with_heavy_lock "$@"',
      'with-heavy-lock-test',
      LOCK_LIB,
      lock,
      '--',
      'bash',
      '-c',
      'exit 0',
    ],
    // Spread first: `env` REPLACES the environment rather than extending it, so
    // an object holding only this one variable would take `PATH` away from
    // `bash` as well.
    { env: { ...process.env, HEAVY_LOCK_WAIT_SECONDS: waitSeconds } },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('with-heavy-lock', () => {
  it('uses one canonical production lock that no caller can move', () => {
    // **The property, restated after the mechanism changed under it.**
    //
    // This case used to stub a fake `flock` on PATH and read the path back out
    // of its argv. `heavy-work-lock` replaced `flock` with `mkdir` — macOS does
    // not ship `flock`, so `bin/h2puni-gate.sh` exited 127 on every Mac and
    // serialised nothing — and this went red for the right reason: it was
    // written against the old implementation.
    //
    // What it guards is unchanged and is worth more than the mechanism was: a
    // caller that can choose its own lock path is a caller that can opt out of
    // the lock, so two heavy runs pick two mutexes and both proceed. The rewrite
    // that broke this test had reintroduced exactly that — a `$WBS_HEAVY_LOCK`
    // override added as a test seam — and this case is what found it. The
    // override is gone; tests pass a path to `with_heavy_lock` directly.
    //
    // Read off the script rather than from a stubbed binary: there is no process
    // to intercept any more, so the check is that the production entry point
    // takes its path from `resolve_heavy_lock_path` and offers no way to supply
    // one.
    const wrapper = readFileSync(SCRIPT, 'utf8');
    const lib = readFileSync(LOCK_LIB, 'utf8');

    // The wrapper hands the resolver's answer straight to the lock, and nothing
    // else.
    expect(wrapper).toContain('with_heavy_lock "$(resolve_heavy_lock_path)" "$@"');
    // Proof: an environment override put back in the resolver — the seam this
    // change removed — and the first of these fails on the name reappearing.
    expect(lib).not.toContain('WBS_HEAVY_LOCK:-');
    expect(lib).toContain('/home/puni1/.cache/wbs-heavy-work.lock');
  });

  it('runs the requested command while the lock is free', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const run = runWithTestLock(join(root, 'heavy.lock'), '0');
    expect(run.exitCode).toBe(0);
  });

  it('refuses immediately with exit 75 while another heavy operation owns the lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const lock = join(root, 'heavy.lock');

    // The holder takes the lock the way production does — through the library —
    // rather than through `flock`, which this test used to call directly and
    // which macOS does not have. A `flock`-held file is invisible to a `mkdir`
    // lock and the refusal below would never fire.
    const holder = Bun.spawn([
      'bash',
      '-c',
      'source "$1"; shift; with_heavy_lock "$@"',
      'heavy-lock-holder',
      LOCK_LIB,
      lock,
      '--',
      'sleep',
      '2',
    ]);
    await Bun.sleep(300);

    // `'0'` is the library's own default and is passed anyway: the point of this
    // case is the no-wait branch, so it says so rather than letting the ambient
    // environment decide which branch runs.
    const refused = runWithTestLock(lock, '0');
    holder.kill();
    await holder.exited;

    // Proof: this reaches the production wrapper and distinguishes contention
    // from command failure by its dedicated conflict exit code.
    expect(refused.exitCode).toBe(75);
  });

  it('queues for the wait budget instead of refusing, and takes the lock when the holder releases it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-'));
    roots.push(root);
    const lock = join(root, 'heavy.lock');

    // The other half of the contract the case above pins, and the reason the
    // inherited value was able to hide: with a budget set, contention is not
    // an error, it is a queue. Nothing covered this, so the refusal case
    // silently became the queueing case under the gate recipe and the only
    // symptom was a timeout.
    //
    // **Every step below is a synchronisation point, and that is the whole
    // point of the case.** It used to sleep 300ms for the holder and then assert
    // that a synchronous contender took longer than four seconds. Both halves of
    // that were inference: on a loaded runner the holder can still be unstarted
    // at 300ms, in which case the contender takes a free lock and exits 0 in
    // milliseconds — a false red; and if subprocess startup alone were delayed
    // past four seconds, both assertions would hold **without the retry branch
    // ever running** — a false green that asserts nothing about queueing.
    const release = join(root, 'release');
    const holderErr = join(root, 'holder.err');
    // The wrapper takes a lock PATH and claims `<path>.d` — the directory whose
    // atomic `mkdir` is the mutex. Watched: with the poll pointed at `lock`
    // itself the readiness wait timed out while the temp root held
    // `heavy.lock.d`, a live holder and a silent stderr.
    const lockDir = `${lock}.d`;
    const holder = Bun.spawn(
      [
        'bash',
        '-c',
        'source "$1"; shift; with_heavy_lock "$@"',
        'heavy-lock-holder',
        LOCK_LIB,
        lock,
        '--',
        // The holder waits on a FILE rather than a timer, and is released by this
        // test creating it. A `sleep N` holder killed with SIGTERM is the obvious
        // alternative and is wrong here: bash defers a trap until the running
        // foreground command returns, so the wrapper's release trap would not fire
        // until the sleep ended anyway. Waiting on a file lets the holder exit
        // normally, which is what "when the holder releases it" means.
        'bash',
        '-c',
        `while [[ ! -e ${JSON.stringify(release)} ]]; do sleep 0.05; done`,
      ],
      // Captured because the readiness wait below is the one place this case can
      // fail without saying why. `heavy-lock-lib.sh` names every refusal path in
      // its own stderr, so a holder that never claims has already explained
      // itself — this stops that explanation being discarded.
      //
      // To a FILE rather than a pipe, deliberately. Reading a piped stream to its
      // end waits for every writer to close it, and the wrapper's inner `bash`
      // child outlives `holder.kill()` and keeps the pipe open — watched turning
      // this case's 10s failure into a 20s timeout, a diagnostic that hung the
      // case it was diagnosing.
      { stderr: openSync(holderErr, 'w') },
    );

    // **Holder readiness, observed.** `claim_heavy_lock` does `mkdir` and *then*
    // writes its pid, so the lock directory exists for an instant before the
    // holder file has contents. Waiting on the directory would re-introduce the
    // race this case exists to remove, so wait for a non-empty `holder`.
    try {
      await until(() => readIfPresent(join(lockDir, 'holder')).trim() !== '');
    } catch (cause) {
      holder.kill();
      const said = readIfPresent(holderErr).trim();
      const listed = (dir: string): string => {
        try {
          return readdirSync(dir).join(',') || '(empty)';
        } catch {
          return '(absent)';
        }
      };
      throw new Error(
        `holder never claimed ${lockDir} (exitCode ${holder.exitCode}); it said: ${said || '(nothing)'}; root has ${listed(root)}; lock has ${listed(lockDir)}`,
        { cause },
      );
    }

    // **The retry, observed.** `heavy-lock-lib.sh` retries with a bare `sleep 5`,
    // and `sleep` is not a bash builtin, so bash resolves it through `PATH`. A
    // `PATH` shim that records each call is therefore direct evidence the
    // contender entered the retry branch — the thing a wall-clock floor can
    // never establish — and it removes the five-second wait that made this the
    // slowest case in the file.
    //
    // The shim is on the CONTENDER's `PATH` only. The holder's own payload calls
    // `sleep` too, so a shared shim would collapse the holder's wait, releasing
    // the lock before the contender ever contended — exactly the false green
    // this case is meant to kill.
    const shim = mkdtempSync(join(tmpdir(), 'wbs-heavy-lock-shim-'));
    roots.push(shim);
    const retries = join(root, 'retries');
    writeFileSync(
      join(shim, 'sleep'),
      // Records the retry, then sleeps a short REAL interval. Returning
      // immediately would leave the wrapper spinning `mkdir` hot until the
      // holder releases; 50ms keeps the case fast without a busy loop.
      `#!/usr/bin/env bash\nprintf 'retry\\n' >>${JSON.stringify(retries)}\nexec /bin/sleep 0.05\n`,
      { mode: 0o755 },
    );

    const queued = Bun.spawn(
      [
        'bash',
        '-c',
        'source "$1"; shift; with_heavy_lock "$@"',
        'with-heavy-lock-test',
        LOCK_LIB,
        lock,
        '--',
        'bash',
        '-c',
        'exit 0',
      ],
      {
        env: {
          ...process.env,
          HEAVY_LOCK_WAIT_SECONDS: '30',
          PATH: `${shim}:${process.env['PATH'] ?? ''}`,
        },
      },
    );

    await until(() => readIfPresent(retries) !== '');
    // Only now is the lock released, so the contender provably took it from a
    // held state rather than finding it free.
    writeFileSync(release, '');
    await holder.exited;

    expect(await queued.exited).toBe(0);
    // Proof: with the contender pointed at a free lock it never enters the retry
    // branch and this file is never written, so the observation is what carries
    // the claim rather than elapsed time.
    expect(readIfPresent(retries)).toContain('retry');
  }, 20_000);
});
