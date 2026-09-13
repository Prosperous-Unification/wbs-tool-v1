import { brokenSource } from './broken-source';
import { createFaultControl, defineFault, type FaultRun } from './faults';

interface TypedSource {
  readonly label: string;
}

function _compileFactorySignature(run: FaultRun<TypedSource>): void {
  const open = brokenSource((label: string): TypedSource => ({ label }), run);
  open('source');

  // Proof: removing this guard fails conformance:typecheck with TS2554 because
  // brokenSource retains the source factory's required argument.
  // @ts-expect-error the broken factory preserves its input signature
  open();
}

defineFault({
  // Proof: removing this guard fails conformance:typecheck with TS2322 because
  // an arbitrary fault name is outside the manifest-derived registry.
  // @ts-expect-error fault IDs are closed over CaseId
  id: 'break:not-a-manifest-case',
  caseId: 'projects.create:steps',
  createControl: () => createFaultControl('typed-phase'),
  mutate: (source: TypedSource) => source,
});

defineFault({
  id: 'break:projects.create:steps',
  // Proof: removing this guard fails conformance:typecheck with TS2322 because
  // the registered fault ID and its owning case differ.
  // @ts-expect-error the case must be the one encoded by the fault ID
  caseId: 'steps.add',
  createControl: () => createFaultControl('typed-phase'),
  mutate: (source: TypedSource) => source,
});
