import { hashCanonical } from './content-manifest';

export type SourceScope = { kind: 'candidate' } | { kind: 'historical'; revision: string };

export type SelectorProvenance =
  | {
      kind: 'extracted';
      extractor: { extractorId: string; version: string; blob: string };
      source: SourceScope;
    }
  | {
      kind: 'declared';
      declarationId: string;
      declarationPath: string;
      selectorVersion: string;
      source: SourceScope;
    };

export interface ContentInput {
  kind: 'content';
  inputId: string;
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

export interface StructuralInput {
  kind: 'structural';
  inputId: string;
  subjectId: string;
  identity: string;
  provenance: SelectorProvenance;
}

export interface SemanticInput {
  kind: 'semantic';
  inputId: string;
  subjectId: string;
  identity: string;
  provenance: SelectorProvenance;
}

export interface TopologyInput {
  kind: 'topology';
  inputId: string;
  topologyKind: 'index-membership' | 'reverse-edges';
  subjectId: string;
  identity: string;
  provenance: SelectorProvenance;
}

export interface CurrencyInputs {
  content: ContentInput[];
  structural: StructuralInput[];
  semantic: SemanticInput[];
  topology: TopologyInput[];
}

export interface CurrencySnapshot {
  sourceBase: string;
  candidateIdentity: string;
  inputs: CurrencyInputs;
}

export interface JudgmentBindings {
  content: { kind: 'content'; inputId: string }[];
  structural: { kind: 'structural'; inputId: string }[];
  semantic: { kind: 'semantic'; inputId: string }[];
  topology: { kind: 'topology'; inputId: string }[];
}

export interface ReviewJudgment {
  judgmentId: string;
  kind: 'content' | 'navigation' | 'relationship' | 'semantic' | 'structural';
  subjectId: string;
  bindings: JudgmentBindings;
}

export type CurrencyAxis = keyof CurrencyInputs;

export interface CurrencyChange {
  axis: CurrencyAxis;
  inputId: string;
  change: 'identity-changed' | 'missing';
}

export interface JudgmentCurrency {
  judgmentId: string;
  kind: ReviewJudgment['kind'];
  subjectId: string;
  status: 'current' | 'stale';
  changes: CurrencyChange[];
}

export interface ContentChange {
  inputId: string;
  reviewed: ContentInput;
  current: ContentInput | undefined;
}

export interface CurrencyReport {
  reviewedSourceBase: string;
  currentSourceBase: string;
  currentCandidateIdentity: string;
  contentChanges: ContentChange[];
  judgments: JudgmentCurrency[];
}

type AxisInput = ContentInput | SemanticInput | StructuralInput | TopologyInput;

function keyed<Input extends AxisInput>(
  inputs: readonly Input[],
  axis: CurrencyAxis,
): Map<string, Input> {
  const byId = new Map<string, Input>();
  for (const input of inputs) {
    // Proof: deleting this guard made
    // `refuses ambiguous inputs and bindings instead of guessing their currency` receive a
    // currency report instead of throwing `duplicate content currency input: content.child`.
    if (byId.has(input.inputId))
      throw new Error(`duplicate ${axis} currency input: ${input.inputId}`);
    byId.set(input.inputId, input);
  }
  return byId;
}

function changed<Input extends AxisInput>(reviewed: Input, current: Input): boolean {
  // Proof: comparing only selector `identity` made
  // `treats declared and extracted provenance as part of selector currency` receive `current`
  // for both the changed extractor version and declared selector version instead of `stale`.
  return hashCanonical(reviewed) !== hashCanonical(current);
}

/** Classifies each review judgment from only its explicitly typed input bindings. */
export function classifyCurrency(
  reviewed: CurrencySnapshot,
  current: CurrencySnapshot,
  judgments: readonly ReviewJudgment[],
): CurrencyReport {
  const reviewedInputs = {
    content: keyed(reviewed.inputs.content, 'content'),
    structural: keyed(reviewed.inputs.structural, 'structural'),
    semantic: keyed(reviewed.inputs.semantic, 'semantic'),
    topology: keyed(reviewed.inputs.topology, 'topology'),
  };
  const currentInputs = {
    content: keyed(current.inputs.content, 'content'),
    structural: keyed(current.inputs.structural, 'structural'),
    semantic: keyed(current.inputs.semantic, 'semantic'),
    topology: keyed(current.inputs.topology, 'topology'),
  };
  const currencies = judgments.map((judgment): JudgmentCurrency => {
    const changes: CurrencyChange[] = [];
    // Proof: broadening navigation judgments to every changed child content input made
    // `a content-only child edit leaves its ancestor navigation judgment current` receive
    // status `stale` with a content change instead of status `current` with no changes.
    // Proof: omitting topology from this binding walk made
    // `new reverse and index edges stale their matching relationship and navigation judgments`
    // receive `current` with no changes for both judgments instead of `stale`.
    // Proof: omitting structural and semantic axes made
    // `public and semantic selector edits stale only their bound consumer judgments` receive
    // `current` with no changes for both changed consumer judgments instead of `stale`.
    for (const axis of ['content', 'structural', 'semantic', 'topology'] as const) {
      for (const binding of judgment.bindings[axis]) {
        const prior = reviewedInputs[axis].get(binding.inputId);
        if (prior === undefined) {
          // Proof: continuing past this absence made
          // `refuses ambiguous inputs and bindings instead of guessing their currency` report
          // the absent structural binding as `current` instead of throwing its named error.
          throw new Error(
            `judgment ${judgment.judgmentId} binds absent reviewed ${axis} input: ${binding.inputId}`,
          );
        }
        const next = currentInputs[axis].get(binding.inputId);
        if (next === undefined) {
          changes.push({ axis, inputId: binding.inputId, change: 'missing' });
        } else if (changed(prior, next)) {
          changes.push({ axis, inputId: binding.inputId, change: 'identity-changed' });
        }
      }
    }
    return {
      judgmentId: judgment.judgmentId,
      kind: judgment.kind,
      subjectId: judgment.subjectId,
      status: changes.length === 0 ? 'current' : 'stale',
      changes,
    };
  });
  const contentChanges = reviewed.inputs.content.flatMap((prior): ContentChange[] => {
    const next = currentInputs.content.get(prior.inputId);
    return next === undefined || changed(prior, next)
      ? [{ inputId: prior.inputId, reviewed: prior, current: next }]
      : [];
  });
  return {
    reviewedSourceBase: reviewed.sourceBase,
    currentSourceBase: current.sourceBase,
    currentCandidateIdentity: current.candidateIdentity,
    contentChanges,
    judgments: currencies,
  };
}
