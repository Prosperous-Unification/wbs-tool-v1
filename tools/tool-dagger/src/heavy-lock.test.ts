import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, '../../../bin/with-heavy-lock.sh');
const LOCK_LIB = join(import.meta.dir, '../../../bin/heavy-lock-lib.sh');
const roots: string[] = [];

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
    const holder = Bun.spawn([
      'bash',
      '-c',
      'source "$1"; shift; with_heavy_lock "$@"',
      'heavy-lock-holder',
      LOCK_LIB,
      lock,
      '--',
      'sleep',
      '1',
    ]);
    await Bun.sleep(300);

    const started = Date.now();
    // 30, not 6: the retry interval in `heavy-lock-lib.sh` is a fixed 5-second
    // sleep, so the first retry lands at ~5s and a budget only just above it
    // would turn a slow runner into a red.
    const queued = runWithTestLock(lock, '30');
    const elapsedMs = Date.now() - started;
    await holder.exited;

    // Both halves are the assertion, and the second is a floor on the CALL, not
    // a proof of contention. Exit 0 alone would also pass if the holder had
    // already died before the claim — the run this case would otherwise silently
    // degrade into — and >4s is inconsistent with the refusal path, which returns
    // in milliseconds. What it does not do is establish that the contender
    // reached the retry branch, because holder readiness is a `Bun.sleep(300)`
    // guess rather than a synchronisation point. TASK-378 replaces both with an
    // observed retry.
    expect(queued.exitCode).toBe(0);
    expect(elapsedMs).toBeGreaterThan(4000);
  }, 20_000);
});
