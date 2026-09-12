import { parseOrThrow, type } from '@wbs/validation';

import {
  ElapsedReceipt,
  ExecutorIdentity,
  InvocationReceipt,
  IsoInstant,
  OpaqueId,
  PriceIdentity,
  RawUsage,
  RelativePath,
  ReviewReceipt,
  SchemaVersion,
} from '../contracts/records';
import { assertCanonicalJsonValue, hashBytes, hashCanonical } from '../evidence/content-manifest';

const Sha256 = type(/^[0-9a-f]{64}$/);
const Judgment = type("'yes'|'partial'|'no'");
const Judgments = type({
  purpose: Judgment,
  relationships: Judgment,
  impact: Judgment,
}).onUndeclaredKey('reject');

export const ReviewProtocol = type({
  protocolId: OpaqueId,
  protocolBlob: Sha256,
}).onUndeclaredKey('reject');

export const ReviewSubjectLocator = type({ kind: "'path'", path: RelativePath })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'repository-root'" }).onUndeclaredKey('reject'));
export type ReviewSubjectLocator = typeof ReviewSubjectLocator.infer;

export const ReviewSubject = type({
  subjectId: OpaqueId,
  kind: "'file'|'directory'|'project'|'documentation'",
  locator: ReviewSubjectLocator,
  contentIdentity: Sha256,
})
  .onUndeclaredKey('reject')
  .narrow((subject, context) =>
    // Proof: accepting repository-root for file made the root-locator production decoder test
    // return an ordinary file subject instead of throwing the named scope refusal.
    subject.locator.kind === 'repository-root' &&
    subject.kind !== 'directory' &&
    subject.kind !== 'project'
      ? context.mustBe('repository root is meaningful only for directory and project subjects')
      : true,
  );

export const ReviewInvocationRequest = type({
  schemaVersion: SchemaVersion,
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  informedContextIds: Sha256.array(),
}).onUndeclaredKey('reject');
export type ReviewInvocationRequest = typeof ReviewInvocationRequest.infer;

export const ColdHarnessRequest = type({
  schemaVersion: SchemaVersion,
  messageKind: "'cold-request'",
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
}).onUndeclaredKey('reject');
export type ColdHarnessRequest = typeof ColdHarnessRequest.infer;

export const ColdJudgment = type({
  sequence: '1',
  judgments: Judgments,
  observedReadIds: Sha256.array(),
}).onUndeclaredKey('reject');
export type ColdJudgment = typeof ColdJudgment.infer;

export const InformedHarnessRequest = type({
  schemaVersion: SchemaVersion,
  messageKind: "'informed-request'",
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  cold: ColdJudgment,
  coldArtifact: Sha256,
  informedContextIds: Sha256.array(),
})
  .onUndeclaredKey('reject')
  .narrow((request, context) =>
    request.coldArtifact === hashCanonical(request.cold)
      ? true
      : context.mustBe('an informed request binding its exact acknowledged cold judgment'),
  );
export type InformedHarnessRequest = typeof InformedHarnessRequest.infer;

const InformedJudgment = type({
  sequence: '3',
  judgments: Judgments,
  observedReadIds: Sha256.array(),
}).onUndeclaredKey('reject');

export const ToolIdentity = type({
  toolId: OpaqueId,
  version: 'string>=1',
}).onUndeclaredKey('reject');
export type ToolIdentity = typeof ToolIdentity.infer;

export const RawResponseRetention = type({ kind: "'journal-inline'" })
  .onUndeclaredKey('reject')
  .or(
    type({
      kind: "'external'",
      artifactUri: 'string>=1',
      // Proof: widening this to any non-empty string let 2026-02-30 decode; the retention test
      // reported "function did not throw" at the retainedUntil assertion.
      retainedUntil: IsoInstant,
    }).onUndeclaredKey('reject'),
  );
export type RawResponseRetention = typeof RawResponseRetention.infer;

export const RetainedRawResponse = type({
  mediaType: "'text/plain'|'application/json'",
  payload: 'string',
  retention: RawResponseRetention,
}).onUndeclaredKey('reject');
export type RetainedRawResponse = typeof RetainedRawResponse.infer;

export const VerifiedTelemetry = type({
  status: "'verified'",
  receipt: InvocationReceipt,
  elapsedReceipts: ElapsedReceipt.array(),
})
  .onUndeclaredKey('reject')
  .narrow((telemetry, context) =>
    telemetry.elapsedReceipts.length > 0
      ? true
      : context.mustBe('verified telemetry with at least one elapsed receipt'),
  );
export type VerifiedTelemetry = typeof VerifiedTelemetry.infer;

// Proof: rebuilding decoded unverified telemetry with `observed: {}` made the partial-telemetry
// test show all known provider/model/usage/charge/time fields replaced by an empty observation.
const PartialTelemetryObservation = type({
  'provider?': 'string>=1',
  'model?': 'string>=1',
  'version?': 'string>=1',
  'effort?': 'string>=1',
  'toolchain?': 'string>=1',
  'executor?': ExecutorIdentity,
  'rawUsage?': RawUsage.array(),
  'priceIdentity?': PriceIdentity,
  'chargedAmountMicros?': 'number.integer>=0',
  'startedAt?': IsoInstant,
  'endedAt?': IsoInstant,
  'elapsedReceipts?': ElapsedReceipt.array(),
}).onUndeclaredKey('reject');

const MissingRequirements = type('string[]').narrow((requirements, context) =>
  requirements.length > 0 && requirements.every((requirement) => requirement.trim().length > 0)
    ? true
    : context.mustBe('one or more named missing telemetry requirements'),
);

export const UnverifiedTelemetry = type({
  status: "'unverified'",
  reason: 'string>=1',
  missingRequirements: MissingRequirements,
  observed: PartialTelemetryObservation,
}).onUndeclaredKey('reject');
export type UnverifiedTelemetry = typeof UnverifiedTelemetry.infer;

export const ReviewTelemetry = VerifiedTelemetry.or(UnverifiedTelemetry);
export type ReviewTelemetry = typeof ReviewTelemetry.infer;

export const ColdHarnessOutput = type({
  schemaVersion: SchemaVersion,
  messageKind: "'cold-completion'",
  invocationId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  cold: ColdJudgment,
  actualTools: ToolIdentity.array(),
  rawResponse: RetainedRawResponse,
  telemetry: ReviewTelemetry,
})
  .onUndeclaredKey('reject')
  .narrow((output, context) =>
    // Proof: reversing this comparison let a mismatched outputArtifact decode; the protocol test
    // reported "function did not throw" at the outputArtifact assertion.
    output.telemetry.status === 'verified' &&
    output.telemetry.receipt.outputArtifact !== hashBytes(output.rawResponse.payload)
      ? context.mustBe('verified cold telemetry whose outputArtifact identifies the raw response')
      : true,
  );
export type ColdHarnessOutput = typeof ColdHarnessOutput.infer;

export const InformedHarnessOutput = type({
  schemaVersion: SchemaVersion,
  messageKind: "'informed-completion'",
  invocationId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  coldArtifact: Sha256,
  informed: InformedJudgment,
  actualTools: ToolIdentity.array(),
  rawResponse: RetainedRawResponse,
  telemetry: ReviewTelemetry,
})
  .onUndeclaredKey('reject')
  .narrow((output, context) =>
    output.telemetry.status === 'verified' &&
    output.telemetry.receipt.outputArtifact !== hashBytes(output.rawResponse.payload)
      ? context.mustBe(
          'verified informed telemetry whose outputArtifact identifies the raw response',
        )
      : true,
  );
export type InformedHarnessOutput = typeof InformedHarnessOutput.infer;

export const ReviewProtocolEvidence = type({
  schemaVersion: SchemaVersion,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  cold: ColdJudgment,
  expansion: type({
    sequence: '2',
    coldJudgmentArtifact: Sha256,
    suppliedContextIds: Sha256.array(),
  }).onUndeclaredKey('reject'),
  informed: InformedJudgment,
})
  .onUndeclaredKey('reject')
  .narrow((evidence, context) =>
    evidence.expansion.coldJudgmentArtifact === hashCanonical(evidence.cold)
      ? true
      : context.mustBe('an expansion whose coldJudgmentArtifact binds the frozen cold judgment'),
  );
export type ReviewProtocolEvidence = typeof ReviewProtocolEvidence.infer;

export const RawResponseReference = type({
  artifact: Sha256,
  retention: RawResponseRetention,
}).onUndeclaredKey('reject');

export const ReviewEvidence = type({
  schemaVersion: SchemaVersion,
  receipt: ReviewReceipt,
  protocolEvidence: ReviewProtocolEvidence,
  phaseReceipts: type({
    cold: VerifiedTelemetry,
    informed: VerifiedTelemetry,
  }).onUndeclaredKey('reject'),
  phaseTools: type({
    cold: ToolIdentity.array(),
    informed: ToolIdentity.array(),
  }).onUndeclaredKey('reject'),
  actualTools: ToolIdentity.array(),
  rawResponse: RawResponseReference,
}).onUndeclaredKey('reject');
export type ReviewEvidence = typeof ReviewEvidence.infer;

function decodedHarnessOutput<Output>(output: Output): Output {
  // Proof: bypassing this assertion made eight real cold/informed Infinity/-0 cases throw
  // `canonical JSON requires a finite number other than negative zero` during journal completion.
  assertCanonicalJsonValue(output);
  return output;
}

export function decodeColdHarnessOutput(input: unknown): ColdHarnessOutput {
  return decodedHarnessOutput(parseOrThrow(ColdHarnessOutput, input));
}

export function decodeInformedHarnessOutput(input: unknown): InformedHarnessOutput {
  return decodedHarnessOutput(parseOrThrow(InformedHarnessOutput, input));
}

export function decodeReviewEvidence(input: unknown): ReviewEvidence {
  return parseOrThrow(ReviewEvidence, input);
}
