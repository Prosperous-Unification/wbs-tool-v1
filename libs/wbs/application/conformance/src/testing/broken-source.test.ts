import { describe, expect, it } from 'bun:test';

import { brokenSource, replaceMethod } from './broken-source';
import {
  createFaultControl,
  defineFault,
  type FaultControl,
  type FaultProofPlan,
  type FaultRun,
  recordFaultProof,
} from './faults';

class CounterPort {
  #count = 0;

  increment(): void {
    this.#count += 1;
  }

  read(): number {
    return this.#count;
  }
}

interface CounterSource {
  readonly port: CounterPort;
}

function counterFault() {
  return defineFault({
    id: 'break:projects.create:steps',
    caseId: 'projects.create:steps',
    createControl: () => createFaultControl('counter-read'),
    mutate(source: CounterSource, control) {
      return {
        port: replaceMethod(source.port, 'read', (read) => () => {
          const count = read();
          return control.reach('counter-read') ? count + 1 : count;
        }),
      };
    },
  });
}

describe('broken source proofs', () => {
  it('an armed fault reaches its named assertion', async () => {
    const fault = counterFault();
    let observed = 0;

    const proof = await recordFaultProof(fault, {
      assertion: 'counter read remains one',
      setup: (run) => {
        const open = brokenSource((): CounterSource => ({ port: new CounterPort() }), run);
        const source = open();
        source.port.increment();
        if (source.port.read() !== 1) throw new Error('baseline counter was not one');
        return Promise.resolve(source);
      },
      exercise: (source) => {
        observed = source.port.read();
        return Promise.resolve();
      },
      assert: () => {
        if (observed !== 1) throw new Error(`expected 1, received ${String(observed)}`);
        return Promise.resolve();
      },
    });

    // Proof: removing the recorder's arm returned `phase-failed` / `fault did
    // not reach counter-read`; activating in setup returned `setup-failed` /
    // `baseline counter was not one` instead of this named assertion failure.
    expect(proof).toEqual({
      kind: 'observed',
      faultId: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      phase: 'counter-read',
      assertion: 'counter read remains one',
      observedFailure: 'expected 1, received 2',
    });
  });

  it('a class port keeps unmodified prototype methods', async () => {
    const fault = counterFault();
    const proof = await recordFaultProof(fault, {
      assertion: 'forwarded methods retain their receiver',
      setup: (run) => {
        const open = brokenSource((): CounterSource => ({ port: new CounterPort() }), run);
        const source = open();
        source.port.increment();
        // Proof: forwarding this prototype method with the Proxy as its receiver
        // failed here on `TypeError: Cannot access invalid private field`.
        expect(source.port.read()).toBe(1);
        return Promise.resolve(source);
      },
      exercise: (_source) => Promise.resolve(),
      assert: () => Promise.resolve(),
    });
    expect(proof.kind).toBe('phase-failed');
  });

  it('a pre-setup failure does not prove an atomicity check', async () => {
    const setupFault = counterFault();
    const setupProof = await recordFaultProof(setupFault, {
      assertion: 'atomic state is unchanged',
      setup: () => Promise.reject(new Error('fixture failed before setup verification')),
      exercise: () => Promise.resolve(),
      assert: () => Promise.reject(new Error('the named assertion failed')),
    });

    // Proof: accepting the setup rejection as proof received `kind: observed`
    // and `observedFailure: fixture failed before setup verification`.
    expect(setupProof).toEqual({
      kind: 'setup-failed',
      faultId: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      failure: 'fixture failed before setup verification',
    });

    const phaseFault = counterFault();
    const phaseProof = await recordFaultProof(phaseFault, {
      assertion: 'atomic state is unchanged',
      setup: () => Promise.resolve({ port: new CounterPort() }),
      exercise: () => Promise.reject(new Error('operation failed before counter-read')),
      assert: () => Promise.reject(new Error('the named assertion failed')),
    });

    // Proof: accepting the pre-phase operation error as proof received
    // `kind: observed` and that operation error as `observedFailure`.
    expect(phaseProof).toEqual({
      kind: 'phase-failed',
      faultId: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      phase: 'counter-read',
      failure: 'operation failed before counter-read',
    });

    const bypassedFault = counterFault();
    const bypassedProof = await recordFaultProof(bypassedFault, {
      assertion: 'atomic state is unchanged',
      setup: () => Promise.resolve({ port: new CounterPort() }),
      exercise: () => Promise.resolve(),
      assert: () => Promise.reject(new Error('an unrelated assertion failed')),
    });

    // Proof: removing the reached-phase check accepted the unrelated assertion
    // as `kind: observed` instead of reporting the bypassed phase.
    expect(bypassedProof).toEqual({
      kind: 'phase-failed',
      faultId: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      phase: 'counter-read',
      failure: 'fault did not reach counter-read',
    });
  });

  it('a different phase cannot satisfy the named fault', async () => {
    const fault = defineFault({
      id: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      createControl: () => createFaultControl<'counter-read' | 'counter-write'>('counter-read'),
      mutate: (source: CounterSource) => source,
    });
    const proof = await recordFaultProof(fault, {
      assertion: 'counter read remains one',
      setup: (run) => Promise.resolve(run),
      exercise: (run) => {
        run.control.reach('counter-write');
        return Promise.resolve();
      },
      assert: () => Promise.reject(new Error('unrelated write assertion')),
    });

    // Proof: accepting any reached phase returned `observed` from the unrelated
    // write assertion instead of the configured counter-read phase failure.
    expect(proof.kind).toBe('phase-failed');
  });

  it('a prior proof cannot satisfy a later proof', async () => {
    const fault = counterFault();
    const first = await recordFaultProof(fault, {
      assertion: 'first assertion',
      setup: (run) => Promise.resolve(run),
      exercise: (run) => {
        run.control.reach('counter-read');
        return Promise.resolve();
      },
      assert: () => Promise.reject(new Error('first failure')),
    });
    const second = await recordFaultProof(fault, {
      assertion: 'second assertion',
      setup: () => Promise.resolve({}),
      exercise: () => Promise.resolve(),
      assert: () => Promise.reject(new Error('unrelated second failure')),
    });

    expect(first.kind).toBe('observed');
    // Proof: retaining the definition's old control returned `observed` here
    // from `unrelated second failure`, although this proof reached no phase.
    expect(second.kind).toBe('phase-failed');
  });

  it('a reused control is refused before another setup', async () => {
    const control = createFaultControl('counter-read');
    const fault = defineFault({
      id: 'break:projects.create:steps',
      caseId: 'projects.create:steps',
      createControl: () => control,
      mutate: (source: CounterSource) => source,
    });
    let setups = 0;
    await recordFaultProof(fault, {
      assertion: 'first assertion',
      setup: (run) => {
        setups += 1;
        return Promise.resolve(run);
      },
      exercise: (run) => {
        run.control.reach('counter-read');
        return Promise.resolve();
      },
      assert: () => Promise.reject(new Error('first failure')),
    });
    const second = await recordFaultProof(fault, {
      assertion: 'second assertion',
      setup: (run) => {
        setups += 1;
        return Promise.resolve(run);
      },
      exercise: () => Promise.resolve(),
      assert: () => Promise.reject(new Error('second failure')),
    });

    // Proof: omitting the pre-setup claim let setup run again, then escaped the
    // recorder on `fault control for counter-read was already armed`.
    expect(second.kind).toBe('setup-failed');
    expect(setups).toBe(1);
  });

  it('a control cannot be armed for a second run', () => {
    const control = createFaultControl('counter-read');
    control.arm();

    // Proof: removing the one-shot guard resolved this second arm without error.
    expect(() => {
      control.arm();
    }).toThrow('already armed');
  });

  it('one fault run cannot open a second source', async () => {
    const proof = await recordFaultProof(counterFault(), {
      assertion: 'a run owns one opened source',
      setup: (run) => {
        const open = brokenSource((): CounterSource => ({ port: new CounterPort() }), run);
        const source = open();
        expect(() => open()).toThrow('opened more than one source');
        return Promise.resolve({ run, source });
      },
      exercise: ({ run }) => {
        run.control.reach('counter-read');
        return Promise.resolve();
      },
      assert: () => Promise.reject(new Error('opened-source assertion')),
    });

    expect(proof.kind).toBe('observed');
  });

  it('concurrent proofs own independent controls', async () => {
    const fault = counterFault();
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = (): void => undefined;
    const firstSetup = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const prove = (
      setup: FaultProofPlan<
        FaultRun<CounterSource>,
        CounterSource,
        'counter-read',
        FaultControl<'counter-read'>
      >['setup'],
    ) =>
      recordFaultProof(fault, {
        assertion: 'independent run assertion',
        setup,
        exercise: (run) => {
          run.control.reach('counter-read');
          return Promise.resolve();
        },
        assert: () => Promise.reject(new Error('independent failure')),
      });
    const first = prove(async (run) => {
      firstEntered();
      await firstHeld;
      expect(run.control.isArmed()).toBe(false);
      return run;
    });
    await firstSetup;
    const second = await prove((run) => Promise.resolve(run));
    releaseFirst();
    const proofs = [await first, second];

    // Proof: sharing one control armed the first proof during its held setup,
    // which failed the inert-setup assertion above on Expected false / Received true.
    expect(proofs.map((proof) => proof.kind)).toEqual(['observed', 'observed']);
  });
});
