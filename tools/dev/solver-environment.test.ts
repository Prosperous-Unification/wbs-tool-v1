import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';

import { scratchSync } from '@tools/test-scratch';
import { describe, expect, it } from 'bun:test';

import {
  assertLocksAgree,
  lockPins,
  solveGoldenRequest,
  solverEnvironment,
  verifySolverEnvironment,
} from './solver-environment';

const repoRoot = resolve(import.meta.dir, '../..');
const linuxLock = readFileSync(
  resolve(repoRoot, 'libs/wbs/adapters/solver-py/requirements.lock'),
  'utf8',
);
const macLock = readFileSync(
  resolve(repoRoot, 'libs/wbs/adapters/solver-py/requirements.macos-arm64.lock'),
  'utf8',
);

describe('lockPins', () => {
  it('reads every pin and normalises the one name the two locks spell differently', () => {
    const pins = lockPins(linuxLock);
    expect(pins.size).toBe(14);
    // The Linux lock writes `typing_extensions`, pip's report writes the same;
    // normalising here is what lets the two maps be compared at all.
    expect(pins.get('typing-extensions')).toBe('4.16.0');
    expect(pins.get('ortools')).toBe('9.15.6755');
  });

  it('refuses a lock with no pins rather than reporting agreement about nothing', () => {
    expect(() => lockPins('# only comments\n')).toThrow('no pins');
  });
});

describe('assertLocksAgree', () => {
  it('accepts the two committed locks', () => {
    expect(() => {
      assertLocksAgree(linuxLock, macLock);
    }).not.toThrow();
  });

  /**
   * The drift this exists for is the one that actually happened: resolving the
   * macOS lock without the Linux pins as constraints selected numpy 2.5.3 where
   * Linux pins 2.5.2. Both files look maintained; the platforms run different
   * code.
   *
   * Proof: deleting the version comparison from `assertLocksAgree` failed this
   * case on `Expected substring: "numpy: linux 2.5.2, macos 2.5.3" / Received
   * function did not throw`.
   */
  it('rejects the numpy split that free resolution actually produced', () => {
    const drifted = macLock.replace('numpy==2.5.2', 'numpy==2.5.3');
    expect(drifted).not.toBe(macLock);
    expect(() => {
      assertLocksAgree(linuxLock, drifted);
    }).toThrow('numpy: linux 2.5.2, macos 2.5.3');
  });

  it('rejects a package present on only one platform', () => {
    const extra = `${macLock}\nsomething-extra==1.0.0 \\\n    --hash=sha256:${'0'.repeat(64)}\n`;
    expect(() => {
      assertLocksAgree(linuxLock, extra);
    }).toThrow('only in the macOS lock');
  });
});

describe('solverEnvironment', () => {
  it('names absolute paths, never a bare interpreter', () => {
    const environment = solverEnvironment('/repo');
    expect(environment.python).toBe('/repo/.venv-solver/bin/python');
    expect(environment.bin).toBe('/repo/.venv-solver/bin');
    expect(environment.lock).toBe(
      '/repo/libs/wbs/adapters/solver-py/requirements.macos-arm64.lock',
    );
    // Proof: restoring the pre-move lock root returned the deleted
    // `/repo/libs/solver-py/requirements.macos-arm64.lock` here.
    // The launcher execs `wbs-solver` through PATH, so `bin` is not a
    // convenience: it is what the local solver must put first.
    expect(environment.bin.endsWith('/bin')).toBe(true);
  });
});

describe('solveGoldenRequest', () => {
  it('reads the request corpus from the namespaced contracts root', () => {
    const root = scratchSync('solver-golden-');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const solver = join(bin, 'wbs-solver');
    writeFileSync(solver, '#!/bin/sh\ncat >/dev/null\nprintf solved\n');
    chmodSync(solver, 0o755);

    // Proof: restoring the reader to `libs/contracts/solver/fixtures` made
    // this real caller throw ENOENT before the fake solver received a request.
    expect(
      solveGoldenRequest(repoRoot, {
        root,
        python: join(bin, 'python'),
        bin,
        lock: 'unused',
      }),
    ).toBe('solved');
  });
});

describe('the cached development test target', () => {
  it('declares the moved source trees its tests read', () => {
    const project = JSON.parse(readFileSync(resolve(import.meta.dir, 'project.json'), 'utf8')) as {
      targets: { test: { inputs?: string[] } };
    };
    const inputs = project.targets.test.inputs;
    expect(inputs).toContain('^production');
    expect(inputs).toContain('{workspaceRoot}/apps/wbs/*/.env.example');
    // Proof: with this assertion and input restored to the pre-move path, a
    // moved Linux numpy mutation returned `[local cache]`, 1/1 hit and exit 0.
    expect(inputs).toContain('{workspaceRoot}/libs/wbs/adapters/solver-py/requirements*.lock');
    expect(inputs).toContain(
      '{workspaceRoot}/libs/wbs/domain/contracts/solver/fixtures/request/valid-quantised-baseline.json',
    );
  });
});

describe('golden corpus writers', () => {
  it('write to the moved domain fixture root', () => {
    const fastWriter = readFileSync(
      resolve(import.meta.dir, 'write-fast-golden-corpus.ts'),
      'utf8',
    );
    const quantumWriter = readFileSync(
      resolve(import.meta.dir, 'write-solver-quantum-golden-corpus.ts'),
      'utf8',
    );

    // Proof: before the active-script sweep repaired both targets, this failed
    // with the complete fast writer source showing the deleted
    // `../../libs/domain/fixtures/fast-golden-corpus.json` destination.
    expect(fastWriter).toContain('../../libs/wbs/domain/domain/fixtures/fast-golden-corpus.json');
    expect(quantumWriter).toContain(
      '../../libs/wbs/domain/domain/fixtures/solver-quantum-golden-corpus.json',
    );
  });
});

describe('verifySolverEnvironment', () => {
  /**
   * A fake interpreter whose two version authorities disagree is the whole
   * point: pip recorded 0.1.1 and the importable package is 0.0.9, which is
   * what an install left behind by an older checkout looks like. Reading either
   * authority alone still says a plausible version.
   *
   * Proof: deleting the comparison failed this case on `Received function did
   * not throw`.
   */
  it('refuses an install whose recorded and importable versions disagree', () => {
    const root = scratchSync('solver-env-');
    mkdirSync(join(root, 'bin'), { recursive: true });
    const python = join(root, 'bin', 'python');
    writeFileSync(
      python,
      `#!/bin/sh\necho '{"pythonVersion":"3.14.2","platform":"darwin","installedVersion":"0.1.1","importedVersion":"0.0.9"}'\n`,
    );
    chmodSync(python, 0o755);
    expect(() => {
      verifySolverEnvironment({ root, python, bin: join(root, 'bin'), lock: 'unused' });
    }).toThrow('stale');
  });

  it('refuses an environment that was never provisioned', () => {
    expect(() => {
      verifySolverEnvironment(solverEnvironment(scratchSync('absent-')));
    }).toThrow('not provisioned');
  });
});
