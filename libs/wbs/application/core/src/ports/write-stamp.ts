/**
 * Who is acting, and when — carried into every write that stores a record.
 *
 * **One object rather than two parameters** because it is one fact: an act has
 * an actor and an instant, and a method that took them separately could be
 * handed one without the other. It is built **once per act** in the service
 * layer, which is the only layer holding both — `actorId` arrives from the
 * controller, `at` from the service's injected `now()` — and every row that act
 * writes carries the same one, so two tables touched by one act can never
 * disagree about when it happened. `WorkItemService.record` already kept that
 * discipline by hand for the journal and the plan event ("two `now()` calls
 * would let one act carry two timestamps"); this makes it the type system's.
 *
 * The repository layer deliberately has **no clock of its own**. Every instant
 * it stores arrived here, which is what lets a test drive time without a fake
 * database, and what stops one act from being dated twice.
 *
 * ADR 0012 records why this is an argument and not ambient per-request context:
 * an argument is found by the compiler at every call site, and `nx typecheck`
 * runs `tsc --build --force`, so a caller that has not been given one fails the
 * gate rather than throwing in production. It does **not** prove the columns are
 * filled — that is `auditOnCreate` / `auditOnUpdate` and `audit.test.ts`, which
 * reads this folder's source and fails naming any write that calls neither.
 */
export interface WriteStamp {
  readonly at: number;
  readonly by: string;
}
