import { createHash } from 'node:crypto';

import {
  canonicalisePlanInput,
  diffPlans,
  normalisePlanInputForward,
  type PlanDiff,
  PlanInputVersionError,
  type PlanScheduleValue,
  type PlanSide,
  type Schedule,
  ScheduleCycleError,
  serialiseCanonicalPlanInput,
} from '@wbs/domain';

import type {
  SavedPlanBodyWrite,
  SavedPlanPrincipals,
  SavedPlanRepository,
  SavedPlanScheduleWrite,
  SavedPlanTouchOutcome,
  SavedPlanWrite,
  StoredSavedPlan,
} from '../repository/saved-plan';
import { bodyByteLength } from '../repository/saved-plan';
import type { PlanInputReads, SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { defaultSavedPlanName } from './saved-plan-default-name';
import { planInputRowsOf } from './saved-plan-input';
import type { SavedPlanIntegrityRefusal } from './saved-plan-integrity';
import {
  assertKnownBodyVersion,
  SUPPORTED_INPUT_BODY_VERSIONS,
  SUPPORTED_SCHEDULE_BODY_VERSIONS,
  verifyBody,
  verifyScheduleLink,
} from './saved-plan-integrity';
import type { SavedPlanQuota, SavedPlanQuotaRefusal } from './saved-plan-quota';
import { bodyBytesRefusal, DEFAULT_SAVED_PLAN_QUOTA, holdingRefusal } from './saved-plan-quota';
import { captureAndSchedulePlan, schedulePlanInput } from './saved-plan-schedule';
import { buildScheduleBody, serialiseScheduleBody } from './saved-plan-schedule-body';

/**
 * Why a saved plan has no schedule body.
 *
 * The three the spec names, and no fourth: `pending` while an optimization run
 * has not answered, `infeasible` for a plan whose dependencies form a cycle,
 * `unavailable` for a scheduling attempt that could not be made at all. Absence
 * always has a reason — `saved_plan`'s check constraint refuses a schedule-less
 * row without one, and a comparison renders it rather than borrowing the live
 * scheduler's dates for a side that never had any.
 */
export type SavedPlanScheduleAbsentReason = 'pending' | 'infeasible' | 'unavailable';

/** What one save asks for. The bodies are read, never passed in. */
export interface SavedPlanSaveRequest {
  readonly projectId: string;
  /**
   * Optional, per assumption A-1: "save writes immediately with the server
   * timestamp as the default name, and naming is an edit afterwards, not a
   * modal". Absent means {@link defaultSavedPlanName} over this save's
   * `created_at` — chosen **here** and never by a caller, because no clock but
   * the one that stamps the record may name it.
   *
   * `undefined` rather than `null`, and that is the narrower of the two on
   * purpose: `null` in this codebase means "no such thing" as a stored fact
   * (see {@link SavedPlanSaveRequest.createdById}), whereas an absent name is a
   * caller declining to choose one and getting a real name anyway. No saved
   * plan is ever nameless.
   */
  readonly name?: string;
  /** The saver's display name, stored by value — never a `users` reference. */
  readonly createdBy: string;
  /**
   * The saving account, by reference — what task 6.1's permission rule reads.
   *
   * Required and nullable, never optional: `null` says "no account is behind
   * this save", which is the same fact a deleted creator leaves and falls back
   * to the project owner. A caller that forgets the field must not compile into
   * that fallback silently. See {@link SavedPlanWrite.createdById}.
   */
  readonly createdById: string | null;
}

/**
 * The four answers a save has, as a union.
 *
 * `refused` carries the quota refusal rather than a boolean because the caller
 * has to say *which* limit was hit; `no_project` is separate from `refused`
 * because a project that does not exist is not a project over its quota, and a
 * route maps them to different statuses.
 *
 * `snapshot_busy` is separate from `refused` for the same reason and a stronger
 * one: a quota refusal is a fact about the project that will still be true in a
 * second, and this one is a fact about *this instant* that a retry may find
 * gone. A surface that folded them together would offer "try again" for a
 * project at its hundredth plan, or fail to offer it here (task 8.5).
 */
export type SavedPlanSaveOutcome =
  | { readonly outcome: 'saved'; readonly record: SavedPlanWrite }
  | { readonly outcome: 'refused'; readonly refusal: SavedPlanQuotaRefusal }
  | { readonly outcome: 'no_project' }
  /** Another connection held the write lock. Nothing was written; a retry may succeed. */
  | { readonly outcome: 'snapshot_busy' };

/** One side of a saved plan, as it was read back and verified. */
export interface SavedPlanReadBody {
  /** The version those bytes were written under, off the header. */
  readonly schemaVersion: number;
  /** The stored bytes, unparsed and unmodified. */
  readonly bytes: string;
  /** The header's hash, which this read recomputed over {@link bytes} and matched. */
  readonly sha256: string;
}

/**
 * The schedule side of a read — present with its bytes, or absent with a reason.
 *
 * A union for the same reason {@link SavedPlanScheduleWrite} is one: the two
 * states have disjoint fields, and a caller that has to test five nullable
 * columns to learn which it holds is a caller that will get it wrong once.
 */
export type SavedPlanReadSchedule =
  | {
      readonly present: true;
      readonly body: SavedPlanReadBody;
      /** The `input_sha256` these dates were computed from, as stored. */
      readonly inputSha256: string;
      readonly algorithmId: string;
    }
  | { readonly present: false; readonly absentReason: string };

/** One saved plan, handed back as it was stored. */
export interface SavedPlanRead {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly input: SavedPlanReadBody;
  readonly schedule: SavedPlanReadSchedule;
}

/**
 * Which side of a comparison a caller named (task 7.3b).
 *
 * A tagged union rather than `string | 'current'`, because the two are not the
 * same kind of thing and a plan whose id happened to be the literal `current`
 * would otherwise silently address the live plan.
 */
export type SavedPlanSideRef =
  | { readonly kind: 'current' }
  | { readonly kind: 'saved'; readonly savedPlanId: string };

/**
 * What a comparison answers.
 *
 * The refusals name the *side* that produced them, because the two sides fail
 * independently and a caller shown "not found" with no id cannot tell which of
 * its two pickers to correct.
 */
export type SavedPlanCompareOutcome =
  | { readonly outcome: 'compared'; readonly diff: PlanDiff }
  | { readonly outcome: 'no_project' }
  | { readonly outcome: 'not_found'; readonly savedPlanId: string }
  | {
      readonly outcome: 'corrupt';
      readonly savedPlanId: string;
      readonly refusal: SavedPlanIntegrityRefusal;
    };

/** One resolved side, or the refusal {@link SavedPlanCompareOutcome} carries out. */
type SavedPlanSideOutcome =
  | { readonly outcome: 'side'; readonly side: PlanSide }
  | Exclude<SavedPlanCompareOutcome, { outcome: 'compared' }>;

/**
 * The three answers a read has.
 *
 * `corrupt` is separate from `not_found` because they are different facts about
 * different things: one plan does not exist, the other exists and cannot be
 * trusted, and a surface that folded them would tell a user their saved plan
 * was never there.
 */
export type SavedPlanReadOutcome =
  | { readonly outcome: 'read'; readonly plan: SavedPlanRead }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'corrupt'; readonly refusal: SavedPlanIntegrityRefusal };

/**
 * One row of a project's saved-plan list.
 *
 * **No body and no integrity verdict**, and both absences are deliberate. The
 * list is the index of a project's permanent records: verifying a hundred plans
 * to render a hundred names would read every stored byte on a page nobody asked
 * to open a plan from, and a list is exactly where {@link SavedPlanService.read}
 * has not been called yet. A corrupt plan is therefore listed like any other and
 * says so when it is opened — which is the honest order, because a plan that
 * cannot be read still exists, still occupies its quota and still has to be
 * deletable.
 *
 * The hashes and lengths ride along because the header already carries them:
 * they cost nothing here and a surface that shows a plan's size has them.
 */
export interface SavedPlanListEntry {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly inputBytes: number;
  /** The schedule side's stored length, or `null` for a schedule-less save. */
  readonly scheduleBytes: number | null;
  /**
   * Why there is no schedule, or `null` when there is one.
   *
   * `string` and not {@link SavedPlanScheduleAbsentReason}, matching the read
   * path exactly: the column is `text`, and `readOfStored` deliberately passes
   * an unrecognised reason through rather than refusing a plan over a label
   * that says nothing about its bytes. A list that narrowed harder than the
   * read would hide a plan the read is willing to hand over.
   */
  readonly scheduleAbsentReason: string | null;
}

/**
 * What a rename or a delete answered, once the permission rule has run.
 *
 * The repository's `SavedPlanTouchOutcome` is the storage layer's three
 * answers; this adds the fourth that only an authorised call can give. They are
 * two different types on purpose: `forbidden` is a fact about an actor and
 * `no_such_plan` is a fact about a row, and the repository is never told who is
 * asking.
 *
 * `not_found` rather than the repository's `no_such_plan`, because this is the
 * vocabulary `statusForRefusal` already maps for every other route.
 */
export type SavedPlanTouchResult =
  | { readonly outcome: 'touched' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'forbidden' }
  /** Another connection held the write lock. Nothing changed; a retry may succeed. */
  | { readonly outcome: 'snapshot_busy' };

/**
 * The repository's answer, in this layer's vocabulary.
 *
 * One function rather than a mapping written out at each of the two call sites,
 * because `no_such_plan` and `not_found` are the same fact under two names and a
 * second copy is how one of them ends up answering `snapshot_busy` as a 404.
 */
function touchResultOf(outcome: SavedPlanTouchOutcome): SavedPlanTouchResult {
  return outcome === 'no_such_plan' ? { outcome: 'not_found' } : { outcome };
}

/**
 * Whether `actorId` may rename or delete the plan those principals describe.
 *
 * **Creator or project owner** (task 6.1, design.md A-8), written as the plain
 * disjunction it is. The "falls back to the project owner" half of A-8 is not a
 * second branch and must not be written as one: `createdById` is `null` exactly
 * when no live account claims the plan, `null` matches no actor id, and the
 * owner arm is then the only one that can be true. A ternary that chose *which*
 * id to compare would say something different and worse — it would stop the
 * owner touching a plan somebody else saved on their project.
 *
 * Exported for its test and for 6.2's matrix. It reads `createdById` and never
 * `createdBy`: the latter is a display name, and an actor id compared against a
 * display name is not a permission check — it is two accounts called "Ada"
 * sharing a right.
 */
export function mayTouchSavedPlan(principals: SavedPlanPrincipals, actorId: string): boolean {
  return principals.createdById === actorId || principals.projectOwnerId === actorId;
}

export interface SavedPlanServiceOptions {
  readonly capture: SavedPlanCaptureRepository;
  readonly plans: SavedPlanRepository;
  /** The saved plan's id. Injected so a test can name the row it then reads. */
  readonly newId: () => string;
  /** Epoch seconds. Injected for the same reason `createdAt` exists at all. */
  readonly now: () => number;
  /**
   * The three limits, **read once here** and not at the call site (task 4.7).
   * A literal at the call site is a limit each caller may spell differently.
   */
  readonly quota?: SavedPlanQuota;
  /**
   * The scheduler the **save** path runs over its detached reads.
   *
   * Injected for one reason, and it is the read path's (task 5.1): a reader
   * that re-derives dates from stored settings passes every comparison of dates
   * a test could make, because it computes the same answer the writer did. The
   * only observation that separates it from a reader returning stored bytes is
   * whether `schedule()` was *called*, and that needs a seam. Defaulted to
   * {@link schedulePlanInput}, so no production caller passes one.
   */
  readonly schedule?: (reads: PlanInputReads) => Schedule;
}

/**
 * The scheduling attempt, as a union rather than a nullable `Schedule`.
 *
 * A cycle is not "no dates"; it is a reason there are none, and the two have to
 * be distinguishable at the type level or the writer will store the first as
 * the second.
 */
type CapturedSchedule =
  | { readonly present: true; readonly planned: Schedule }
  | { readonly present: false; readonly absentReason: SavedPlanScheduleAbsentReason };

/** One capture's reads and the outcome of scheduling them. */
interface ScheduleAttempt {
  readonly reads: PlanInputReads;
  readonly schedule: CapturedSchedule;
}

/**
 * A body and the hash taken over the exact bytes that will be stored.
 *
 * Serialize, hash, store — in that order and over one string, so the hash a
 * reader recomputes is over the bytes it read and not over a second rendering
 * of the same value. Every `JSON.stringify` in this feature is upstream of this
 * function; nothing re-serializes after the digest is taken.
 */
function bodyWrite(bytes: string, schemaVersion: number): SavedPlanBodyWrite {
  return {
    schemaVersion,
    bytes,
    sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
  };
}

/**
 * Saves a plan: capture, schedule, serialize, hash, check, write.
 *
 * **Order is the design (design.md, "Write order").** Per-body byte checks
 * first, because they depend on nothing in the database. Then `BEGIN
 * IMMEDIATE`, and only inside it the count and total — read outside, two saves
 * at 99 of 100 both pass and both commit while "refused before any row is
 * written" stays technically true. {@link SavedPlanRepository.write} takes that
 * second check as a parameter for exactly this reason, so this class hands it
 * over rather than running it first.
 */
export class SavedPlanService {
  private readonly quota: SavedPlanQuota;
  private readonly schedule: (reads: PlanInputReads) => Schedule;

  constructor(private readonly opts: SavedPlanServiceOptions) {
    this.quota = opts.quota ?? DEFAULT_SAVED_PLAN_QUOTA;
    this.schedule = opts.schedule ?? schedulePlanInput;
  }

  /**
   * Hands back one saved plan's stored bytes, or says why it will not.
   *
   * **Nothing is recomputed and nothing is parsed** (task 5.1). The bodies go
   * out as the bytes on disk, and this method holds no scheduler, no clock and
   * no plan input: the whole value of a saved plan is that it answers with what
   * was true when it was saved, and a reader that re-derived anything would
   * answer with what is true now while looking identical on every field a test
   * usually asserts.
   *
   * **What it does do is check** (task 5.1b). Every read recomputes SHA-256
   * over each body's stored bytes and compares it with the header, because a
   * hash nothing recomputes is a comment. 2.4's guard is a source scan — it
   * proves no `UPDATE` is written in this repository, and cannot see a disk
   * fault, a restored backup or a write from outside this process. A mismatch
   * is a typed refusal naming the plan and the body; it is never repaired and
   * never defaulted, because the bytes are the record and this code has no
   * standing to guess what they should have been.
   */
  async read(savedPlanId: string): Promise<SavedPlanReadOutcome> {
    const stored = await this.opts.plans.readOf(savedPlanId);
    if (stored === null) return { outcome: 'not_found' };
    return readOfStored(stored);
  }

  /**
   * The live plan as a comparison side. Writes nothing and consumes no quota.
   *
   * **It reuses {@link captureAndAttempt}, which is the save path's own
   * capture**, rather than reads of its own (task 7.3). Spec requires `current`
   * to come through the same canonical function the save uses, and the reason
   * is concrete: a `current` built from the projection's twelve awaited reads
   * lacks the registry and junction rows *by value*, so every saved-vs-current
   * comparison would report the saved side's tags, types and external systems
   * as removed. The diff's own completeness property never catches that — it
   * mutates `CanonicalPlanInput` values directly and never runs this path.
   *
   * Reuse also gives `current` the one `BEGIN DEFERRED` read snapshot. Without
   * it a torn `current` renders a comparison against a live plan that never
   * existed — the display-side twin of the defect the torn-read test (3.2)
   * exists to catch.
   *
   * **`current` carries a schedule, and it is not an absent one** (task 7.3a).
   * Spec's stored-schedule bound lawfully permits returning `unavailable` here,
   * and that would answer "no schedule was saved" about the live side of this
   * feature's primary direction. So the schedule is `schedule()`'s return over
   * the values just captured — computed **outside** the read snapshot, as
   * {@link captureAndAttempt} already arranges for the save path — labelled
   * with the algorithm identity currently in force, with a `ScheduleCycleError`
   * mapping to `infeasible` on the same derivation a save records.
   *
   * The body is round-tripped through {@link serialiseScheduleBody} rather than
   * handed over as the built object. The live side must compare against a
   * stored side on identical serialization terms; comparing a live object
   * against parsed stored bytes would report every difference the serializer
   * normalises away as a real one.
   */
  async projectCurrentPlan(projectId: string): Promise<PlanSide | null> {
    const attempt = await this.captureAndAttempt(projectId);
    if (attempt === null) return null;
    const input = canonicalisePlanInput(planInputRowsOf(attempt.reads));
    if (!attempt.schedule.present) {
      return { input, schedule: { present: false, absentReason: attempt.schedule.absentReason } };
    }
    // The captured project's own start date, not today's — `scheduleWrite`'s
    // rule, for the same reason: re-rendering against a start that has since
    // moved would restate the plan.
    const built = buildScheduleBody(attempt.schedule.planned, attempt.reads.project.startDate);
    return {
      input,
      schedule: {
        present: true,
        algorithmId: built.algorithmId,
        body: JSON.parse(serialiseScheduleBody(built)) as PlanScheduleValue,
      },
    };
  }

  /**
   * A project's saved plans, newest first — headers only, and **unverified**.
   *
   * The asymmetry with {@link read} is the point and not an oversight. `read`
   * recomputes both digests because it is handing over bytes somebody will act
   * on; this hands over an index, and verifying it would mean reading every
   * stored body of every plan to draw a list of names. A plan whose bytes are
   * damaged is listed like any other and refuses when it is opened, which is
   * also the only behaviour under which a corrupt plan can be found and deleted
   * rather than becoming a row that occupies quota and cannot be reached.
   *
   * The absent reason is passed through as stored, not narrowed to the three
   * this build knows. That is `readOfStored`'s rule and this stays consistent
   * with it: refusing a list because one row's reason string is unfamiliar
   * would deny access to every other plan in the project over a label.
   */
  async list(projectId: string): Promise<SavedPlanListEntry[]> {
    const rows = await this.opts.plans.listOf(projectId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      inputBytes: row.inputBytes,
      scheduleBytes: row.scheduleBytes,
      scheduleAbsentReason: row.scheduleAbsentReason,
    }));
  }

  /**
   * Compares two sides of one project's plan (task 7.3b's service half).
   *
   * **Both sides are resolved against `projectId`, and a saved plan that
   * belongs elsewhere answers `not_found`.** The project id is not decoration
   * on this route the way it would be on {@link read}: `current` has no id of
   * its own and can only mean "the live plan of the project named in the path",
   * so the path's project is load-bearing here. Once it is, a side that names a
   * plan of some *other* project has to be refused rather than compared, or the
   * route quietly compares two projects and reports every work item of each as
   * added and removed — and, worse, a caller who may read project A's plans
   * could name one of them beside `current` on project B.
   *
   * `not_found` rather than a distinct "wrong project": the caller learns
   * exactly what a caller naming a plan id that does not exist learns, which is
   * the same rule {@link read}'s single-prefix URL enforces structurally.
   *
   * **The stored side is parsed here and normalised forward** (task 7.4), never
   * rewritten. {@link readOfStored} has already refused a version outside
   * `SUPPORTED_INPUT_BODY_VERSIONS`, so today's normalisation is the identity
   * and its three refusals are unreachable from this path — stated rather than
   * claimed as coverage. It is called anyway because the day a second version
   * exists is the day this call is the only thing standing between an old body
   * and a diff that reports a removed field as a change nobody made.
   */
  async compare(
    projectId: string,
    left: SavedPlanSideRef,
    right: SavedPlanSideRef,
  ): Promise<SavedPlanCompareOutcome> {
    const leftSide = await this.sideOf(projectId, left);
    if (leftSide.outcome !== 'side') return leftSide;
    const rightSide = await this.sideOf(projectId, right);
    if (rightSide.outcome !== 'side') return rightSide;
    return { outcome: 'compared', diff: diffPlans(leftSide.side, rightSide.side) };
  }

  /**
   * One side of {@link compare}, or the refusal that stands in for it.
   *
   * `current` answering `null` is `no_project`: {@link projectCurrentPlan}
   * returns it when the project is gone, which is the same fact the route's own
   * project read would have found a moment earlier.
   */
  private async sideOf(projectId: string, ref: SavedPlanSideRef): Promise<SavedPlanSideOutcome> {
    if (ref.kind === 'current') {
      const side = await this.projectCurrentPlan(projectId);
      return side === null ? { outcome: 'no_project' } : { outcome: 'side', side };
    }
    /*
      **Scope before bytes**, and the order is the finding.

      This check used to sit *after* `read`, which verifies every stored byte
      and can answer `corrupt`. A corrupt saved plan belonging to **another**
      project therefore left here as 422 `corrupt` — naming the foreign id and
      its condition — where every foreign plan is promised the same
      indistinguishable 404 an unknown id gets. Sol's I2 on PR 202: the path's
      project id was authoritative on the healthy path and not on the error
      paths, which is where a prober would look.

      `principalsOf` is the right read for it and already exists for exactly
      this shape of question: one header row, no bodies parsed, no hashes
      recomputed. It is what `refuseUnauthorisedTouch` authorises rename and
      delete off, and for the reason stated there — a plan too damaged to open
      must still be answerable *about*.

      No second scope check after the read: `project_id` is written once and
      never updated (`saved-plan.ts`: "No `UPDATE` is issued here, ever", and
      rename touches `name` alone), so the two reads cannot disagree about
      which project owns a plan.
    */
    const principals = await this.opts.plans.principalsOf(ref.savedPlanId);
    // `?.` covers both refusals in one read, and they are the same refusal: a
    // plan that is not there and a plan that is somebody else's are both
    // `not_found` here, deliberately, so neither can be told from the other.
    if (principals?.projectId !== projectId) {
      return { outcome: 'not_found', savedPlanId: ref.savedPlanId };
    }
    const found = await this.read(ref.savedPlanId);
    if (found.outcome === 'not_found')
      return { outcome: 'not_found', savedPlanId: ref.savedPlanId };
    if (found.outcome === 'corrupt') {
      return { outcome: 'corrupt', savedPlanId: ref.savedPlanId, refusal: found.refusal };
    }
    /*
      `planSideOfRead` normalises the stored input forward, and that throws.

      `normalisePlanInputForward` refuses a version it cannot bring to this
      build's — unparseable, from the future, or with no upgrade step — by
      throwing `PlanInputVersionError`, and nothing caught it here. Elysia
      answered **500** for a database state the code anticipates by name, which
      R5 forbids: a plan this node cannot read is a modelled refusal, not a
      crash. Gemini's F-02 on PR 202. It joins the other three integrity
      refusals and leaves as the same 422 the route already sends for `corrupt`.
    */
    try {
      return { outcome: 'side', side: planSideOfRead(found.plan) };
    } catch (failure) {
      if (!(failure instanceof PlanInputVersionError)) throw failure;
      return {
        outcome: 'corrupt',
        savedPlanId: ref.savedPlanId,
        refusal: {
          reason: 'input_version_unreadable',
          savedPlanId: ref.savedPlanId,
          body: 'input',
          storedVersion: failure.storedVersion,
          readerVersion: failure.readerVersion,
          versionReason: failure.reason,
        },
      };
    }
  }

  /**
   * Renames a saved plan, if `actorId` may touch it. Writes `name` and nothing
   * else — the repository's one `UPDATE` is the whole of the write.
   *
   * **Authorised off `principalsOf`, never off {@link read}.** `read` verifies
   * every stored byte and can answer `corrupt`, and a corrupt plan must stay
   * renameable and deletable or it holds its project's quota forever with
   * nothing able to reach it. Routing the check through `read` would make "your
   * saved plan is damaged" and "you may not rename your damaged saved plan" the
   * same answer.
   *
   * **Not the project's ordinary write rule** (`canEdit`), and that is the point
   * of task 6.1: on an unrestricted project every authenticated account may
   * write, so the ordinary rule would let any account relabel anybody's
   * permanent record. A saved plan is not an editable row of the plan; it is
   * somebody's record of it.
   */
  async rename(savedPlanId: string, actorId: string, name: string): Promise<SavedPlanTouchResult> {
    const refusal = await this.refuseUnauthorisedTouch(savedPlanId, actorId);
    if (refusal !== null) return refusal;
    return touchResultOf(await this.opts.plans.renameTo(savedPlanId, name));
  }

  /**
   * Deletes a saved plan, if `actorId` may touch it. Both body rows go with the
   * header, by the schema's own cascade.
   *
   * The same rule as {@link rename} and deliberately the same one: deleting is
   * the only way a saved plan leaves, so anybody who may relabel a record may
   * also destroy it and nobody else may do either.
   */
  async delete(savedPlanId: string, actorId: string): Promise<SavedPlanTouchResult> {
    const refusal = await this.refuseUnauthorisedTouch(savedPlanId, actorId);
    if (refusal !== null) return refusal;
    return touchResultOf(await this.opts.plans.deleteOf(savedPlanId));
  }

  /**
   * The shared half of {@link rename} and {@link delete}: `null` when the touch
   * may proceed, otherwise the answer to give instead.
   *
   * There is a race here and it is the harmless direction. The principals are
   * read on one connection and the write is issued on another, so a plan deleted
   * in between turns an authorised rename into `not_found` — which is the truth
   * a moment later. What cannot happen is the other order: nothing in this
   * repository ever changes `created_by_id` or a project's owner, so an actor
   * authorised by this read cannot have lost the right by the time the write
   * runs.
   */
  private async refuseUnauthorisedTouch(
    savedPlanId: string,
    actorId: string,
  ): Promise<SavedPlanTouchResult | null> {
    const principals = await this.opts.plans.principalsOf(savedPlanId);
    if (principals === null) return { outcome: 'not_found' };
    if (!mayTouchSavedPlan(principals, actorId)) return { outcome: 'forbidden' };
    return null;
  }

  async save(request: SavedPlanSaveRequest): Promise<SavedPlanSaveOutcome> {
    // Stamped **before** the capture opens, never after it commits. The spec's
    // rule is that `created_at` labels when the plan was looked at, and a
    // capture is slow enough for the two to differ; taking it here can only be
    // earlier than the snapshot, never later, so the label never claims to
    // cover a write that happened after it.
    const createdAt = this.opts.now();
    const attempt = await this.captureAndAttempt(request.projectId);
    if (attempt === null) return { outcome: 'no_project' };

    // Folded once. The header's `input_schema_version` is read off **this**
    // value rather than from `CANONICAL_PLAN_INPUT_SCHEMA_VERSION` a second
    // time, for the reason {@link scheduleWrite} states about the schedule
    // side: the version stored beside the bytes is the version those bytes
    // carry, not a constant that happened to agree with them.
    const canonical = canonicalisePlanInput(planInputRowsOf(attempt.reads));
    const input = bodyWrite(serialiseCanonicalPlanInput(canonical), canonical.schemaVersion);
    const schedule = scheduleWrite(attempt, input.sha256);

    const early = bodyBytesRefusal(
      {
        input: bodyByteLength(input.bytes),
        schedule: schedule.present ? bodyByteLength(schedule.body.bytes) : null,
      },
      this.quota,
    );
    if (early !== null) return { outcome: 'refused', refusal: early };

    const record: SavedPlanWrite = {
      id: this.opts.newId(),
      projectId: request.projectId,
      // A-1's default, off the `createdAt` above rather than a second clock
      // read: the name and the timestamp it claims to be are one value. `??`
      // and not `||`, so a caller who genuinely sends `''` is refused by the
      // route's `minLength: 1` instead of being quietly renamed here.
      name: request.name ?? defaultSavedPlanName(createdAt),
      createdBy: request.createdBy,
      createdById: request.createdById,
      createdAt,
      input,
      schedule,
    };
    const written = await this.opts.plans.write<SavedPlanQuotaRefusal>(
      record,
      (holding, incoming) => Promise.resolve(holdingRefusal(holding, incoming, this.quota)),
    );
    // Switched over rather than tested for `null`, so a fourth repository
    // outcome would stop compiling here instead of being read as a save.
    switch (written.outcome) {
      case 'written':
        return { outcome: 'saved', record };
      case 'refused':
        return { outcome: 'refused', refusal: written.refusal };
      case 'snapshot_busy':
        return { outcome: 'snapshot_busy' };
    }
  }

  /**
   * The capture and its scheduling run, with a cycle recovered rather than lost.
   *
   * A plan whose dependencies form a cycle is still **saved** — with the reason
   * `infeasible` and no schedule body — so this needs the capture's reads on the
   * path where `schedule()` threw. `captureAndSchedulePlan` cannot return them:
   * it composes the two and a throw takes the whole call with it. So the
   * outcome is recorded in the injected scheduler, which is handed the reads,
   * and the `ScheduleCycleError` is **re-thrown** from there: the composition's
   * own return value is never made to lie about a schedule it does not have,
   * and every other caller of it sees the cycle exactly as before.
   *
   * The connection is already closed when the scheduler runs (task 3.3), so a
   * throw out of it leaks no handle.
   *
   * Collected into an array rather than assigned to a `ScheduleAttempt | null`:
   * an assignment inside a callback stays `null` to the narrowing, and the
   * length also distinguishes "the scheduler never ran" — a project that does
   * not exist — from "it ran and found nothing".
   */
  private async captureAndAttempt(projectId: string): Promise<ScheduleAttempt | null> {
    const attempts: ScheduleAttempt[] = [];
    try {
      await captureAndSchedulePlan(this.opts.capture, projectId, (reads: PlanInputReads) => {
        try {
          const planned = this.schedule(reads);
          attempts.push({ reads, schedule: { present: true, planned } });
          return planned;
        } catch (failure) {
          if (!(failure instanceof ScheduleCycleError)) throw failure;
          attempts.push({ reads, schedule: { present: false, absentReason: 'infeasible' } });
          throw failure;
        }
      });
    } catch (failure) {
      if (!(failure instanceof ScheduleCycleError)) throw failure;
    }
    return attempts.length === 0 ? null : attempts[0];
  }
}

/**
 * Verifies one stored saved plan and shapes it, or refuses it.
 *
 * A free function over {@link StoredSavedPlan} rather than a method, so the
 * whole verification is testable by handing it bytes — including the states a
 * database cannot easily be made to produce — while the service method above
 * stays the one line that fetches.
 *
 * The header decides which sides exist and the bodies are checked against it:
 * `schedule_sha256` is null exactly when no schedule was saved (the
 * `saved_plan_schedule_all_or_nothing` check makes that an invariant of the
 * table, not a hope), so an absent schedule is read off the header rather than
 * inferred from a missing body row. Inferring it the other way would turn a
 * body a cascade half-deleted into a legitimately schedule-less plan.
 */
/**
 * A verified read, as a comparison side (task 7.3b).
 *
 * The bytes are parsed here and **nowhere else**: {@link SavedPlanService.read}
 * hands over the stored bytes unparsed on purpose, so the one place that turns
 * them into values is the one place that also runs them forward through
 * {@link normalisePlanInputForward}. Splitting those two apart is how a body
 * comes to be diffed at its stored shape against a reader that has moved on.
 */
function planSideOfRead(plan: SavedPlanRead): PlanSide {
  return {
    input: normalisePlanInputForward(JSON.parse(plan.input.bytes), plan.input.schemaVersion),
    schedule: plan.schedule.present
      ? {
          present: true,
          algorithmId: plan.schedule.algorithmId,
          body: JSON.parse(plan.schedule.body.bytes) as PlanScheduleValue,
        }
      : { present: false, absentReason: plan.schedule.absentReason },
  };
}

function readOfStored(stored: StoredSavedPlan): SavedPlanReadOutcome {
  const header = stored.header;
  // Task 5.5, and **before** the hash check on purpose: a body this reader
  // cannot parse is unreadable whether or not its bytes are intact, and
  // recomputing a digest first would answer a question nobody can act on.
  assertKnownBodyVersion(
    header.id,
    'input',
    header.inputSchemaVersion,
    SUPPORTED_INPUT_BODY_VERSIONS,
  );
  const inputRefusal = verifyBody(header.id, 'input', stored.bodies.input, header.inputSha256);
  if (inputRefusal !== null) return { outcome: 'corrupt', refusal: inputRefusal };
  // Narrowed by the check above rather than asserted: `verifyBody` returns a
  // `body_missing` refusal for null, so reaching here means the bytes are there.
  const inputBytes = stored.bodies.input ?? '';

  const schedule = scheduleOfStored(stored);
  if (schedule.outcome === 'corrupt') return schedule;

  return {
    outcome: 'read',
    plan: {
      id: header.id,
      projectId: header.projectId,
      name: header.name,
      createdBy: header.createdBy,
      createdAt: header.createdAt,
      input: {
        schemaVersion: header.inputSchemaVersion,
        bytes: inputBytes,
        sha256: header.inputSha256,
      },
      schedule: schedule.schedule,
    },
  };
}

/** The schedule half of {@link readOfStored}, verified the same way. */
function scheduleOfStored(
  stored: StoredSavedPlan,
):
  | { outcome: 'ok'; schedule: SavedPlanReadSchedule }
  | { outcome: 'corrupt'; refusal: SavedPlanIntegrityRefusal } {
  const header = stored.header;
  if (
    header.scheduleSha256 === null ||
    header.scheduleSchemaVersion === null ||
    header.scheduleInputSha256 === null ||
    header.schedulerAlgorithmId === null
  ) {
    return {
      outcome: 'ok',
      // The check constraint makes this non-null whenever the four above are
      // null. `?? 'unavailable'` is the one default in this file and it is for
      // a row that could not have been written by this code; a reader that
      // threw here would refuse a plan over a reason string rather than over
      // anything about the plan's own bytes.
      schedule: { present: false, absentReason: header.scheduleAbsentReason ?? 'unavailable' },
    };
  }
  assertKnownBodyVersion(
    header.id,
    'schedule',
    header.scheduleSchemaVersion,
    SUPPORTED_SCHEDULE_BODY_VERSIONS,
  );
  const refusal = verifyBody(header.id, 'schedule', stored.bodies.schedule, header.scheduleSha256);
  if (refusal !== null) return { outcome: 'corrupt', refusal };
  // Task 5.2, and it runs **after** the byte check rather than instead of it:
  // the two answer different questions — whether the schedule body is the one
  // that was written, and whether the dates in it belong to this plan's input —
  // and a record can fail either with the other intact.
  const link = verifyScheduleLink(header.id, header.scheduleInputSha256, header.inputSha256);
  if (link !== null) return { outcome: 'corrupt', refusal: link };
  return {
    outcome: 'ok',
    schedule: {
      present: true,
      body: {
        schemaVersion: header.scheduleSchemaVersion,
        bytes: stored.bodies.schedule ?? '',
        sha256: header.scheduleSha256,
      },
      inputSha256: header.scheduleInputSha256,
      algorithmId: header.schedulerAlgorithmId,
    },
  };
}

/**
 * The schedule side of the write, built from the attempt.
 *
 * The header's `schema_version` and `scheduler_algorithm_id` are read **off the
 * built body** rather than from the constants a second time. The body already
 * carries both, and two independent readings of one fact are two things that
 * can drift; a reader that checks the header against the body would then have
 * to decide which is right.
 *
 * `inputSha256` is this save's own input hash, stored so a reader can *check*
 * that these dates were computed from these rows and refuse to render them
 * against an input that did not produce them.
 */
function scheduleWrite(attempt: ScheduleAttempt, inputSha256: string): SavedPlanScheduleWrite {
  if (!attempt.schedule.present) {
    return { present: false, absentReason: attempt.schedule.absentReason };
  }
  // The captured project's own start date, not today's: re-rendering the dates
  // against a start that has since moved would restate the plan.
  const built = buildScheduleBody(attempt.schedule.planned, attempt.reads.project.startDate);
  return {
    present: true,
    body: bodyWrite(serialiseScheduleBody(built), built.version),
    inputSha256,
    algorithmId: built.algorithmId,
  };
}
