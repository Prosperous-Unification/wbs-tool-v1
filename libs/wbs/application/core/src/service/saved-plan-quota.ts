/**
 * The three bounds on saved plans, and the two decisions taken against them.
 *
 * Spec: "A body over **8 MiB**, a project already holding **100** saved plans,
 * or a project whose saved plans already total **64 MiB** SHALL cause the save
 * to be refused before any header or body is written, with a typed outcome
 * naming which limit was reached. Those three numbers SHALL be configuration,
 * changeable without a migration." So they are values on an object a caller may
 * replace, not literals spelled into the writer, and not columns.
 *
 * **Two decisions, not one, because they run in different places.** The
 * per-body byte check depends on nothing in the database and runs before
 * `BEGIN IMMEDIATE`; the count and total depend on what the project already
 * holds and MUST be read inside that transaction. Outside it, two saves at 99
 * of 100 both pass and both commit, and the bound is broken while "refused
 * before any row is written" stays technically true (design.md, "Write order").
 * Writing them as one function would have to be called once, in one place, and
 * whichever place that was would be wrong for the other half.
 *
 * Both are pure. The writer supplies the numbers it has already read; nothing
 * here opens a connection or knows one exists.
 */

/** The bound reached, when one was. Each names a limit a caller can act on. */
export type SavedPlanLimit = 'body_bytes' | 'plan_count' | 'project_bytes';

/**
 * A refusal, naming the limit, what was asked for and what the limit is.
 *
 * `asked` and `limit` ride along because the surface's job is to tell somebody
 * why their save did not happen, and "too big" without either number is a
 * sentence they can do nothing with. They are in the same units as each other
 * and as the limit named by `limit` — bytes for two of the three, plans for the
 * other.
 */
export interface SavedPlanQuotaRefusal {
  readonly limit: SavedPlanLimit;
  readonly asked: number;
  readonly allowed: number;
}

/** The three numbers, as configuration. */
export interface SavedPlanQuota {
  /** Most bytes in any ONE body. Applies to each side separately, not to their sum. */
  readonly mostBytesPerBody: number;
  /** Most saved plans one project may hold at once. */
  readonly mostPlansPerProject: number;
  /** Most bytes one project's saved bodies may total. */
  readonly mostBytesPerProject: number;
}

/**
 * The shipped values: 8 MiB, 100 plans, 64 MiB.
 *
 * Written as `n * 1024 * 1024` rather than as `8_388_608` so the number in the
 * spec and the number here are the same string, and a later change to one of
 * them is a one-token edit that cannot silently land on a different power.
 */
export const DEFAULT_SAVED_PLAN_QUOTA: SavedPlanQuota = {
  mostBytesPerBody: 8 * 1024 * 1024,
  mostPlansPerProject: 100,
  mostBytesPerProject: 64 * 1024 * 1024,
};

/**
 * The pre-transaction check: is either body on its own too big?
 *
 * Takes the bodies' **byte lengths**, not the bodies, because that is what the
 * writer already has — it has serialized and measured both sides to fill
 * `input_bytes` and `schedule_bytes`, and passing the strings would invite a
 * second, differently-counted measurement of the same fact. A `null` schedule
 * side is an absent schedule, which is not a body and is not measured.
 *
 * The input side is checked first, so a save with both sides over the limit
 * refuses naming the input. Two limits reached is still one refusal, and the
 * one worth naming is the side the plan cannot be saved without.
 */
export function bodyBytesRefusal(
  bytes: { readonly input: number; readonly schedule: number | null },
  quota: SavedPlanQuota = DEFAULT_SAVED_PLAN_QUOTA,
): SavedPlanQuotaRefusal | null {
  if (bytes.input > quota.mostBytesPerBody) {
    return { limit: 'body_bytes', asked: bytes.input, allowed: quota.mostBytesPerBody };
  }
  if (bytes.schedule !== null && bytes.schedule > quota.mostBytesPerBody) {
    return { limit: 'body_bytes', asked: bytes.schedule, allowed: quota.mostBytesPerBody };
  }
  return null;
}

/** What a project already holds, as read inside the write transaction. */
export interface SavedPlanHolding {
  /** How many saved plans the project holds now. */
  readonly plans: number;
  /** The total byte length of every body it holds now, both kinds. */
  readonly bytes: number;
}

/**
 * The in-transaction check: would this save put the project over either bound?
 *
 * **The comparison is against the state after the save, not before it.** The
 * count limit is "a project already holding 100 saved plans is refused
 * another", so 100 held refuses and 99 held admits the hundredth; the byte
 * limit is on the total the project would then hold, so the incoming bytes are
 * added before comparing. A check written against the current total alone
 * admits one body of any size onto a project one byte under the limit.
 *
 * `incomingBytes` is the sum of the bodies this save is about to write —
 * already known to pass {@link bodyBytesRefusal}, which is a different
 * question: one 8 MiB body is legal, and the ninth one on a project is not.
 *
 * The count is checked before the total for {@link bodyBytesRefusal}'s reason:
 * a project at both bounds is refused naming the one it will still be at after
 * deleting a single plan.
 */
export function holdingRefusal(
  holding: SavedPlanHolding,
  incomingBytes: number,
  quota: SavedPlanQuota = DEFAULT_SAVED_PLAN_QUOTA,
): SavedPlanQuotaRefusal | null {
  if (holding.plans + 1 > quota.mostPlansPerProject) {
    return { limit: 'plan_count', asked: holding.plans + 1, allowed: quota.mostPlansPerProject };
  }
  const total = holding.bytes + incomingBytes;
  if (total > quota.mostBytesPerProject) {
    return { limit: 'project_bytes', asked: total, allowed: quota.mostBytesPerProject };
  }
  return null;
}
