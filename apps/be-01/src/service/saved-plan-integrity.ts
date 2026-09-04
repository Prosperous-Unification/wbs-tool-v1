import { createHash } from 'node:crypto';

import type { PlanInputNormaliseFailure } from '@wbs/domain';

/** Which of a saved plan's two sides a refusal is about. */
export type SavedPlanBodyKind = 'input' | 'schedule';

/**
 * Why a stored saved plan could not be handed back.
 *
 * Every case names the saved plan **and** the body, because the caller that
 * surfaces this has one plan open and two sides in front of it, and "this saved
 * plan is corrupt" tells a reader nothing about which half to distrust.
 *
 * These are refusals rather than repairs on purpose (R5): a hash that disagrees
 * with its bytes is not a value to fix up, and re-deriving either side would
 * produce a plan the product calls saved and nobody ever saved.
 */
export type SavedPlanIntegrityRefusal =
  | {
      readonly reason: 'body_missing';
      readonly savedPlanId: string;
      readonly body: SavedPlanBodyKind;
    }
  | {
      readonly reason: 'body_hash_mismatch';
      readonly savedPlanId: string;
      readonly body: SavedPlanBodyKind;
      /** The header's hash, as written beside the bytes. */
      readonly stored: string;
      /** SHA-256 over the bytes actually read back. */
      readonly recomputed: string;
    }
  | {
      /**
       * The stored dates were computed from an input that is not this record's.
       *
       * Distinct from `body_hash_mismatch` because **both bodies may be
       * perfectly intact**: each hashes to its own header column, and the fault
       * is in the *link* between them. A reader told "the schedule body is
       * corrupt" would go looking for damaged bytes that are not damaged.
       */
      readonly reason: 'schedule_input_mismatch';
      readonly savedPlanId: string;
      readonly body: 'schedule';
      /** The input hash the saved dates were computed from. */
      readonly scheduleInputSha256: string;
      /** The input hash this record actually holds. */
      readonly inputSha256: string;
    }
  | {
      /**
       * The input's bytes are intact and this reader cannot bring them forward.
       *
       * The fourth reason a stored plan cannot be handed back, and the only one
       * that is not about damage: every hash agrees, and
       * `normalisePlanInputForward` still refuses because the stored
       * `input_schema_version` is unparseable, newer than this build, or has no
       * upgrade step to the current one. It threw `PlanInputVersionError` out of
       * the compare path and Elysia answered **500** — an unmodelled crash for a
       * database state the code already anticipates, which R5 forbids. Gemini
       * F-02 on PR 202.
       *
       * `versionReason` is `PlanInputVersionError.reason` verbatim, because the
       * three cases are different operational facts: `from-the-future` means a
       * newer node wrote it and this one should be upgraded, `no-upgrade-path`
       * means the migration chain has a hole, and `not-a-version` means the
       * column holds something that was never a version.
       */
      readonly reason: 'input_version_unreadable';
      readonly savedPlanId: string;
      readonly body: 'input';
      /** The version stored beside the bytes. */
      readonly storedVersion: number;
      /** The version this build reads. */
      readonly readerVersion: number;
      readonly versionReason: PlanInputNormaliseFailure;
    };

/**
 * SHA-256 over a body's stored bytes, in the one encoding the writer used.
 *
 * `utf8` is named here for the same reason `bodyByteLength` names it: a digest
 * taken over a different encoding of the same string is a different digest, and
 * a reader that guessed would refuse every plan ever written.
 */
export function bodySha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/**
 * Recomputes one body's hash over the bytes read back and compares it.
 *
 * The comparison is against the bytes **this read obtained**, never against a
 * second rendering of a parsed value — a check that re-serialized first would
 * pass over a body whose stored bytes had been rewritten into something that
 * happens to parse the same way, which is most of what a partial write leaves
 * behind.
 *
 * An absent body is its own refusal rather than a mismatch against the empty
 * string: `saved_plan_body` has no row to be empty, so the two states are
 * distinguishable at the source and folding them would report a hash fault for
 * a row that a cascade deleted.
 */
export function verifyBody(
  savedPlanId: string,
  body: SavedPlanBodyKind,
  bytes: string | null,
  stored: string,
): SavedPlanIntegrityRefusal | null {
  if (bytes === null) return { reason: 'body_missing', savedPlanId, body };
  const recomputed = bodySha256(bytes);
  if (recomputed === stored) return null;
  return { reason: 'body_hash_mismatch', savedPlanId, body, stored, recomputed };
}

/**
 * Checks that the saved dates were computed from the input stored beside them.
 *
 * Task 5.2. Two hashes that both verify against their own bytes still leave one
 * question open — whether these dates are *this plan's* dates — and the writer
 * answers it by storing the input hash it scheduled over. A reader that
 * rendered the schedule without checking would show a user dates belonging to
 * an input they can no longer see, which is worse than showing none.
 *
 * **This comparison only means anything because 2.4 makes both header columns
 * unrewritable.** If `schedule_input_sha256` could be `UPDATE`d, one statement
 * satisfies this check for a schedule computed from something else, and the
 * check becomes a comment about a column rather than a fact about the record.
 */
export function verifyScheduleLink(
  savedPlanId: string,
  scheduleInputSha256: string,
  inputSha256: string,
): SavedPlanIntegrityRefusal | null {
  if (scheduleInputSha256 === inputSha256) return null;
  return {
    reason: 'schedule_input_mismatch',
    savedPlanId,
    body: 'schedule',
    scheduleInputSha256,
    inputSha256,
  };
}

/**
 * The versions of each body this build knows how to read.
 *
 * A **set per side**, not the current constant, because the two clauses of task
 * 5.5 pull in opposite directions: a body written at version *n* has to keep
 * reading after the reader moves to *n+1*, and a version the reader has never
 * heard of has to fail loudly. Comparing against
 * `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` alone would satisfy the second clause by
 * breaking the first — every record written before the bump becomes unreadable
 * the moment the constant moves, which is the opposite of what a saved plan is
 * for. So the current constant is one member of these lists and a bump adds to
 * them rather than replacing them; removing a member is a deliberate decision
 * about records that already exist (design.md, "Cross-version diffs normalise
 * forward only").
 */
export const SUPPORTED_INPUT_BODY_VERSIONS: readonly number[] = [1];
export const SUPPORTED_SCHEDULE_BODY_VERSIONS: readonly number[] = [1];

/**
 * A stored body written under a schema version this build does not know.
 *
 * A **throw**, where 5.1b and 5.2 are typed refusals in the outcome union, and
 * the asymmetry is deliberate: those are facts about one record — this plan's
 * bytes are damaged, this plan's dates belong elsewhere — and a route maps them
 * to an answer about that plan. An unknown version is a fact about the *build*:
 * every record at that version is unreadable here, and the honest report is
 * that this reader is too old, not that one saved plan is broken. R5's rule
 * covers both: malformed trusted data is never defaulted away.
 */
export class UnknownSavedPlanBodyVersionError extends Error {
  constructor(
    readonly savedPlanId: string,
    readonly body: SavedPlanBodyKind,
    readonly version: number,
    readonly supported: readonly number[],
  ) {
    super(
      `saved plan ${savedPlanId}: ${body} body is at schema version ${String(version)}, ` +
        `which this reader does not know (knows ${supported.map(String).join(', ')})`,
    );
    this.name = 'UnknownSavedPlanBodyVersionError';
  }
}

/**
 * Throws unless the version is one this reader knows.
 *
 * `supported` is a parameter rather than read off the constants inside, so that
 * the rule itself — an older member passes, a stranger throws — is testable
 * without inventing a schema version that does not exist yet. The production
 * call sites pass the two lists above.
 */
export function assertKnownBodyVersion(
  savedPlanId: string,
  body: SavedPlanBodyKind,
  version: number,
  supported: readonly number[],
): void {
  if (supported.includes(version)) return;
  throw new UnknownSavedPlanBodyVersionError(savedPlanId, body, version, supported);
}
