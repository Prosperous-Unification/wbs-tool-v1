import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, '../../../bin/with-heavy-lock.sh');
const LOCK_LIB = join(import.meta.dir, '../../../bin/heavy-lock-lib.sh');
const roots: string[] = [];
// Runs before the temp roots are removed, so a case can register the release
// file and process kills that its own failure path would otherwise skip.
// Peer review, 2026-09-08: on a readiness or marker timeout the release file
// is never written, so the holder's inner `bash` — which outlives
// `holder.kill()`, as this file already measured — polls for it forever.
const cleanups: (() => void | Promise<void>)[] = [];

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
    if (Date.now() >= deadline)
      throw new Error(`condition not observed within ${String(timeoutMs)}ms`);
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
      // Cleanup runs after a failure as often as after a pass; a throw here
      // would replace the real failure with a cleanup error.
    }
  }
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

  // Budget stated, not defaulted (TASK-415). Measured 2016ms on h2puni at
  // load 7-9, a 2.5x margin on the 5000ms default -- and
  // TASK-288 timed out on exactly this case; dfe395fd fixed inheritance, not the margin.
  // The rule is 5x the measured floor, rounded up to the next second.
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
  }, 11000);

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
    const holderErrFd = openSync(holderErr, 'w');
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
      { stderr: holderErrFd },
    );
    // **The failure paths, not only the happy one.** Both waits below throw on
    // timeout, and neither the release file nor a kill would otherwise happen.
    // Writing the release file is what actually ends the holder: killing the
    // outer process leaves the inner `bash` polling, which is the same
    // observation the stderr-to-a-file comment above records.
    cleanups.push(async () => {
      // Release FIRST, then wait: the release file is what lets the holder's
      // inner payload return, and only then can the wrapper's deferred trap
      // run. `holder.kill()` alone was watched leaving the outer wrapper alive
      // 28 seconds after a failed case, with its payload already gone.
      writeFileSync(release, '');
      holder.kill();
      // SIGTERM is deferred while a foreground command runs, so a wrapper that
      // is still there after a second is not going to leave on its own.
      const left = await Promise.race([
        holder.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]);
      if (!left) {
        holder.kill('SIGKILL');
        await holder.exited;
      }
      // `openSync` hands back a descriptor this case owns; removing the temp
      // root does not close it, so a watch-mode loop would accumulate them.
      closeSync(holderErrFd);
    });

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
        `holder never claimed ${lockDir} (exitCode ${String(holder.exitCode)}); it said: ${said || '(nothing)'}; root has ${listed(root)}; lock has ${listed(lockDir)}`,
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
      //
      // **It records only the retry loop's own interval, and that guard is the
      // assertion.** `heavy-lock-lib.sh` retries with a bare `sleep 5`, so a
      // shim that recorded EVERY call would let any other `sleep` in the
      // contender write the marker — peer review named an ambient `BASH_ENV`
      // startup script as the concrete route, which bash sources before
      // `with_heavy_lock` makes its first claim. The marker would then be there
      // before the contention it is supposed to be evidence of, and the case
      // would go green on a free lock: the exact false green this task removed.
      // Any other `sleep` is passed through unchanged rather than swallowed.
      `#!/usr/bin/env bash\n` +
        `if [[ \${1:-} == 5 ]]; then\n` +
        `  printf 'retry\\n' >>${JSON.stringify(retries)}\n` +
        `  exec /bin/sleep 0.05\n` +
        `fi\n` +
        `exec /bin/sleep "$@"\n`,
      { mode: 0o755 },
    );

    // **The contender's environment is built from an allowlist, not inherited.**
    //
    // This started as `...process.env` and lost two rounds of peer review to the
    // same shape of finding: bash reads things out of its environment before it
    // runs the command it was given, and every one of them can call `sleep 5`
    // and write the retry marker before `with_heavy_lock` makes its first
    // claim. Round 2 named `BASH_ENV`, the startup file bash sources for a
    // non-interactive shell. Round 3 named exported functions: a `BASH_FUNC_x%%`
    // entry is imported as a shell function, so an ambient `dirname` that calls
    // `sleep 5` fires while the wrapper is still computing the lock's parent.
    // Both make the case pass on a lock nobody held.
    //
    // Subtracting the routes one at a time is a losing game — each round found
    // another one, and the next reader inherits whatever bash adds later. The
    // contender is a `bash -c` running one library function, so it is named
    // exhaustively instead: the shim's `PATH`, the wait budget the case is
    // about, and `HOME` because tooling under it expects one. Nothing else
    // reaches it, so nothing else can write the marker.
    const contenderEnv: Record<string, string> = {
      PATH: `${shim}:${process.env['PATH'] ?? ''}`,
      HEAVY_LOCK_WAIT_SECONDS: '30',
      HOME: process.env['HOME'] ?? root,
    };

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
        env: contenderEnv,
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
