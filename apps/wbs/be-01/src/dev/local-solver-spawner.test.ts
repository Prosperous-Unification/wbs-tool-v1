import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  createSolverChildEnvironment,
  localSolverCapabilities,
  solverBinDirectory,
} from './local-solver-spawner';

describe('solverBinDirectory', () => {
  /**
   * `tools/dev/solver-environment.ts` provisions `.venv-solver` at the repo
   * root, so the project directory must climb exactly to the directory holding
   * `nx.json`. The real project directory is used rather than a fake one,
   * because the fault is a depth that stopped matching the tree.
   *
   * Proof: restoring the pre-namespacing `'../..'` failed this case with
   * `Expected: true / Received: false`.
   */
  it('resolves the provisioned bin under the repo root', () => {
    const projectDirectory = resolve(import.meta.dir, '../..');
    const bin = solverBinDirectory(projectDirectory);
    expect(bin.endsWith(join('.venv-solver', 'bin'))).toBe(true);
    expect(existsSync(join(bin, '..', '..', 'nx.json'))).toBe(true);
  });
});

describe('createSolverChildEnvironment', () => {
  /**
   * The launcher's own `os.execvp("wbs-solver", ...)` is a second lookup, and it
   * resolves through the child's PATH rather than through the absolute path used
   * to start the launcher. Putting the provisioned `bin` anywhere but first lets
   * an ambient install win.
   *
   * Proof: appending instead of prepending failed this case on
   * `Expected: "/repo/.venv-solver/bin:/usr/bin:/bin" / Received:
   * "/usr/bin:/bin:/repo/.venv-solver/bin"`.
   */
  it('puts the provisioned bin ahead of everything inherited', () => {
    const child = createSolverChildEnvironment('/repo/.venv-solver/bin', {
      PATH: '/usr/bin:/bin',
    });
    expect(child['PATH']).toBe('/repo/.venv-solver/bin:/usr/bin:/bin');
  });

  /**
   * An inherited import path can put a different `wbs_solver` in front of the
   * provisioned one — the same stale-install fault `verifySolverEnvironment`
   * refuses, arriving at spawn time where nothing re-checks versions.
   *
   * Proof: forwarding them — dropping only `PATH` from the skip list — failed
   * this case with `Received: "/somewhere/else"` for `PYTHONPATH`.
   */
  it('drops inherited Python import overrides', () => {
    const child = createSolverChildEnvironment('/bin-dir', {
      PATH: '/usr/bin',
      PYTHONPATH: '/somewhere/else',
      PYTHONHOME: '/another/python',
      HOME: '/Users/dev',
    });
    expect(child['PYTHONPATH']).toBeUndefined();
    expect(child['PYTHONHOME']).toBeUndefined();
    // Everything unrelated still reaches the child.
    expect(child['HOME']).toBe('/Users/dev');
  });

  it('refuses to guess an environment when PATH is unset', () => {
    expect(() => createSolverChildEnvironment('/bin-dir', {})).toThrow('PATH is unset');
    expect(() => createSolverChildEnvironment('/bin-dir', { PATH: '' })).toThrow('PATH is unset');
  });
});

describe('localSolverCapabilities', () => {
  it('states the three guarantees the Darwin profile does not have', () => {
    expect(localSolverCapabilities('darwin')).toEqual({
      kind: 'local-solver',
      parentDeath: 'no-immediate-termination',
      memoryEnforcement: 'none',
      oomEvidence: 'unavailable',
      deadline: 'child-alarm-only',
    });
  });

  /**
   * On Linux the launcher arms `PR_SET_PDEATHSIG` and its `RLIMIT_AS` backstop
   * (`launcher.py`), so reporting Darwin's absences there would understate the
   * profile, while a cgroup ceiling and OOM evidence are still absent.
   *
   * Proof: returning the Darwin record for every platform failed this case on
   * `- "parentDeath": "kernel-signal",` / `+ "parentDeath":
   * "no-immediate-termination",`.
   */
  it('states what the launcher arms on Linux and what is still absent', () => {
    expect(localSolverCapabilities('linux')).toEqual({
      kind: 'local-solver',
      parentDeath: 'kernel-signal',
      memoryEnforcement: 'address-space-backstop',
      oomEvidence: 'unavailable',
      deadline: 'child-alarm-only',
    });
  });

  /**
   * Proof: returning the Darwin record for every platform failed this case on
   * `Received function did not throw`.
   */
  it('refuses a platform whose launcher guarantees were never examined', () => {
    expect(() => localSolverCapabilities('win32')).toThrow('win32');
  });

  it('cannot be edited into claiming a guarantee it lacks', () => {
    expect(Object.isFrozen(localSolverCapabilities('linux'))).toBe(true);
    expect(Object.isFrozen(localSolverCapabilities('darwin'))).toBe(true);
  });
});
