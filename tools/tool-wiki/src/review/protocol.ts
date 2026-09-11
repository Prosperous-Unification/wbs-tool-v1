import { parseOrThrow, type } from '@wbs/validation';

import {
  ElapsedReceipt,
  InvocationReceipt,
  IsoInstant,
  OpaqueId,
  RelativePath,
  ReviewReceipt,
  SchemaVersion,
} from '../contracts/records';
import { hashBytes, hashCanonical } from '../evidence/content-manifest';

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

export const ReviewSubject = type({
  subjectId: OpaqueId,
  kind: "'file'|'directory'|'project'|'documentation'",
  path: RelativePath,
  contentIdentity: Sha256,
}).onUndeclaredKey('reject');

export const ReviewInvocationRequest = type({
  schemaVersion: SchemaVersion,
  invocationId: OpaqueId,
  receiptId: OpaqueId,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
}).onUndeclaredKey('reject');
export type ReviewInvocationRequest = typeof ReviewInvocationRequest.infer;

const ColdJudgment = type({
  sequence: '1',
  judgments: Judgments,
  observedReadIds: Sha256.array(),
}).onUndeclaredKey('reject');

const InformedExpansion = type({
  sequence: '2',
  coldJudgmentArtifact: Sha256,
  suppliedContextIds: Sha256.array(),
}).onUndeclaredKey('reject');

const InformedJudgment = type({
  sequence: '3',
  judgments: Judgments,
  observedReadIds: Sha256.array(),
}).onUndeclaredKey('reject');

export const ReviewProtocolEvidence = type({
  schemaVersion: SchemaVersion,
  protocol: ReviewProtocol,
  subject: ReviewSubject,
  cold: ColdJudgment,
  expansion: InformedExpansion,
  informed: InformedJudgment,
})
  .onUndeclaredKey('reject')
  // Proof: replacing this binding comparison with true made "refuses an expansion" fail: "Received function did not throw".
  .narrow((evidence, context) =>
    evidence.expansion.coldJudgmentArtifact === hashCanonical(evidence.cold)
      ? true
      : context.mustBe('an expansion whose coldJudgmentArtifact binds the frozen cold judgment'),
  );
export type ReviewProtocolEvidence = typeof ReviewProtocolEvidence.infer;

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
      // Proof: widening this to a non-empty string made "requires a real retention horizon" fail: "Received function did not throw".
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

const VerifiedTelemetry = type({
  status: "'verified'",
  receipt: InvocationReceipt,
  elapsedReceipts: ElapsedReceipt.array(),
})
  .onUndeclaredKey('reject')
  // Proof: replacing this length comparison with true made "refuses verified telemetry" fail: "Received function did not throw".
  .narrow((telemetry, context) =>
    telemetry.elapsedReceipts.length > 0
      ? true
      : context.mustBe('verified telemetry with at least one elapsed receipt'),
  );

const UnverifiedTelemetry = type({
  status: "'unverified'",
  reason: 'string>=1',
})
  // Proof: removing undeclared-key rejection made "models absent required telemetry" accept chargedAmountMicros: 0 and fail "Received function did not throw".
  .onUndeclaredKey('reject');

export const ReviewTelemetry = VerifiedTelemetry.or(UnverifiedTelemetry);
export type ReviewTelemetry = typeof ReviewTelemetry.infer;

export const HarnessOutput = type({
  schemaVersion: SchemaVersion,
  messageKind: "'review-completion'",
  invocationId: OpaqueId,
  protocolEvidence: ReviewProtocolEvidence,
  actualTools: ToolIdentity.array(),
  rawResponse: RetainedRawResponse,
  telemetry: ReviewTelemetry,
})
  .onUndeclaredKey('reject')
  .narrow((output, context) => {
    // Proof: bypassing this comparison made "refuses verified telemetry" fail: "Received function did not throw" for a forged outputArtifact.
    if (
      output.telemetry.status === 'verified' &&
      output.telemetry.receipt.outputArtifact !== hashBytes(output.rawResponse.payload)
    ) {
      return context.mustBe('verified telemetry whose outputArtifact identifies the raw response');
    }
    return true;
  });
export type HarnessOutput = typeof HarnessOutput.infer;

export const RawResponseReference = type({
  artifact: Sha256,
  retention: RawResponseRetention,
}).onUndeclaredKey('reject');
export type RawResponseReference = typeof RawResponseReference.infer;

export const ReviewEvidence = type({
  schemaVersion: SchemaVersion,
  receipt: ReviewReceipt,
  protocolEvidence: ReviewProtocolEvidence,
  actualTools: ToolIdentity.array(),
  rawResponse: RawResponseReference,
}).onUndeclaredKey('reject');
export type ReviewEvidence = typeof ReviewEvidence.infer;

/** Validates one operator-harness response before the journal can retain it. */
export function decodeHarnessOutput(input: unknown): HarnessOutput {
  return parseOrThrow(HarnessOutput, input);
}

/** Validates one writer-supplied review evidence record before provenance comparison. */
export function decodeReviewEvidence(input: unknown): ReviewEvidence {
  return parseOrThrow(ReviewEvidence, input);
}
