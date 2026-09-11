import { Buffer } from 'node:buffer';

import { parseOrThrow, type } from '@wbs/validation';

import { OpaqueId, RelativePath } from '../contracts/records';
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

export type ContentChange =
  | { change: 'added'; inputId: string; current: ContentInput }
  | { change: 'changed'; inputId: string; reviewed: ContentInput; current: ContentInput }
  | { change: 'removed'; inputId: string; reviewed: ContentInput };

export interface CurrencyReport {
  reviewedSourceBase: string;
  currentSourceBase: string;
  currentCandidateIdentity: string;
  contentChanges: ContentChange[];
  judgments: JudgmentCurrency[];
}

type AxisInput = ContentInput | SemanticInput | StructuralInput | TopologyInput;

const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
const SourceScopeRecord = type({ kind: "'candidate'" })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'historical'", revision: GitIdentity }).onUndeclaredKey('reject'));
const ExtractedProvenance = type({
  kind: "'extracted'",
  extractor: type({
    extractorId: OpaqueId,
    version: OpaqueId,
    blob: Sha256,
  }).onUndeclaredKey('reject'),
  source: SourceScopeRecord,
}).onUndeclaredKey('reject');
const DeclaredProvenance = type({
  kind: "'declared'",
  declarationId: OpaqueId,
  declarationPath: RelativePath,
  selectorVersion: OpaqueId,
  source: SourceScopeRecord,
}).onUndeclaredKey('reject');
const SelectorProvenanceRecord = ExtractedProvenance.or(DeclaredProvenance);
const ContentInputRecord = type({
  kind: "'content'",
  inputId: OpaqueId,
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitIdentity,
}).onUndeclaredKey('reject');
const StructuralInputRecord = type({
  kind: "'structural'",
  inputId: OpaqueId,
  subjectId: OpaqueId,
  identity: Sha256,
  provenance: SelectorProvenanceRecord,
}).onUndeclaredKey('reject');
const SemanticInputRecord = type({
  kind: "'semantic'",
  inputId: OpaqueId,
  subjectId: OpaqueId,
  identity: Sha256,
  provenance: SelectorProvenanceRecord,
}).onUndeclaredKey('reject');
const TopologyInputRecord = type({
  kind: "'topology'",
  inputId: OpaqueId,
  topologyKind: "'index-membership'|'reverse-edges'",
  subjectId: OpaqueId,
  identity: Sha256,
  provenance: SelectorProvenanceRecord,
}).onUndeclaredKey('reject');
const CurrencySnapshotRecord = type({
  // Proof: widening this to any string made
  // `rejects malformed currency snapshots at the public boundary` return a currency report whose
  // reviewed source base was `working-tree` instead of throwing at the boundary.
  sourceBase: GitIdentity,
  candidateIdentity: Sha256,
  inputs: type({
    content: ContentInputRecord.array(),
    structural: StructuralInputRecord.array(),
    semantic: SemanticInputRecord.array(),
    topology: TopologyInputRecord.array(),
  }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
const JudgmentBindingsRecord = type({
  content: type({ kind: "'content'", inputId: OpaqueId }).onUndeclaredKey('reject').array(),
  structural: type({ kind: "'structural'", inputId: OpaqueId }).onUndeclaredKey('reject').array(),
  semantic: type({ kind: "'semantic'", inputId: OpaqueId }).onUndeclaredKey('reject').array(),
  topology: type({ kind: "'topology'", inputId: OpaqueId }).onUndeclaredKey('reject').array(),
}).onUndeclaredKey('reject');
const ReviewJudgmentRecord = type({
  judgmentId: OpaqueId,
  kind: "'content'|'navigation'|'relationship'|'semantic'|'structural'",
  subjectId: OpaqueId,
  bindings: JudgmentBindingsRecord,
}).onUndeclaredKey('reject');

/** Decodes one strict currency snapshot before currency logic can observe it. */
export function decodeCurrencySnapshot(input: unknown): CurrencySnapshot {
  return parseOrThrow(CurrencySnapshotRecord, input);
}

/** Decodes strict judgment bindings before currency logic can observe them. */
export function decodeReviewJudgments(input: unknown): ReviewJudgment[] {
  return parseOrThrow(ReviewJudgmentRecord.array(), input);
}

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

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

function assertUniqueJudgments(judgments: readonly ReviewJudgment[]): void {
  const judgmentIds = new Set<string>();
  for (const judgment of judgments) {
    // Proof: deleting this refusal made
    // `refuses conflicting judgments with the same identity` return two differently scoped
    // `judgment.duplicate` currency entries instead of throwing the named duplicate error.
    if (judgmentIds.has(judgment.judgmentId)) {
      throw new Error(`duplicate review judgment: ${judgment.judgmentId}`);
    }
    judgmentIds.add(judgment.judgmentId);
  }
}

/** Classifies each review judgment from only its explicitly typed input bindings. */
export function classifyCurrency(
  reviewedInput: unknown,
  currentInput: unknown,
  judgmentsInput: unknown,
): CurrencyReport {
  const reviewed = decodeCurrencySnapshot(reviewedInput);
  const current = decodeCurrencySnapshot(currentInput);
  const judgments = decodeReviewJudgments(judgmentsInput);
  assertUniqueJudgments(judgments);
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
  // Proof: enumerating only reviewed content made
  // `reports content introduced only by the current candidate as added` receive `[]` instead of
  // the explicit `content.added` change; enumerating only current content made
  // `reports content absent from the current candidate as removed` receive `[]` instead of the
  // explicit `content.child` removal.
  const contentInputIds = [
    ...new Set([...reviewedInputs.content.keys(), ...currentInputs.content.keys()]),
  ].sort(compareText);
  const contentChanges = contentInputIds.flatMap((inputId): ContentChange[] => {
    const prior = reviewedInputs.content.get(inputId);
    const next = currentInputs.content.get(inputId);
    if (prior === undefined && next !== undefined)
      return [{ change: 'added', inputId, current: next }];
    if (prior !== undefined && next === undefined) {
      return [{ change: 'removed', inputId, reviewed: prior }];
    }
    if (prior !== undefined && next !== undefined && changed(prior, next)) {
      return [{ change: 'changed', inputId, reviewed: prior, current: next }];
    }
    return [];
  });
  return {
    reviewedSourceBase: reviewed.sourceBase,
    currentSourceBase: current.sourceBase,
    currentCandidateIdentity: current.candidateIdentity,
    contentChanges,
    judgments: currencies,
  };
}
