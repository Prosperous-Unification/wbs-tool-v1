import type { ProjectApi } from '@/lib/wbs-api';

/**
 * The names of `T`'s methods — the keys a recorder may wrap.
 *
 * `never[]` rather than `unknown[]` in the constraint so that a method of any
 * arity matches: parameters are contravariant, and `(id: string) => …` is not
 * assignable to `(...args: unknown[]) => …`.
 */
type MethodNames<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** One method of the project client, by name. */
export type ProjectApiMethod = MethodNames<ProjectApi>;

/**
 * Records what a test's fake client was asked to write, and lets the write
 * happen.
 *
 * **Forty-five copies of five lines**, across nine test files, each binding the
 * real method, replacing it with a closure that pushes its arguments and
 * delegates, and returning the array — eight of them wrapped in a local
 * `watchX` helper and the rest inline. The plan's W1-1 asks for one.
 *
 * The delegation is the part worth having in one place. A recorder that pushed
 * and **returned** — no `perform(...)` — makes every assertion built on it
 * vacuous in the most expensive way: the request is recorded, the fake's plan
 * never changes, and the test goes on to assert about a screen that was never
 * written to. Each of the forty-five got that right; the forty-sixth is the one
 * to worry about. `records what it was asked and still performs it` is the
 * negative, on this function.
 *
 * The projection keeps every call site's own array shape, which is why it
 * exists rather than the tuple alone: some sites want the patch, some want
 * `[id, patch]`, one wants a deep copy taken before the fake can mutate it.
 * Without an `of`, the recorded entry is the whole argument tuple — **typed**,
 * where a hand-rolled `unknown[][]` was not.
 *
 * `api` is the fake to wrap, mutated in place as all forty-five copies did;
 * `method` names the write to watch; `of` says what to remember per call, and
 * absent remembers the arguments. Written as prose rather than as `@param`
 * tags because the doc sits on the **first overload**, which has no `of` — and
 * a tag for a parameter that signature does not declare is a lie the linter
 * catches.
 *
 * @returns The recorded entries, in call order — the same array the test reads
 * as calls arrive.
 */
export function recordCalls<M extends ProjectApiMethod>(
  api: ProjectApi,
  method: M,
): Parameters<ProjectApi[M]>[];
export function recordCalls<M extends ProjectApiMethod, T>(
  api: ProjectApi,
  method: M,
  of: (...args: Parameters<ProjectApi[M]>) => T,
): T[];
export function recordCalls<M extends ProjectApiMethod, T>(
  api: ProjectApi,
  method: M,
  of?: (...args: Parameters<ProjectApi[M]>) => T,
): (T | Parameters<ProjectApi[M]>)[] {
  const recorded: (T | Parameters<ProjectApi[M]>)[] = [];
  type Call = (...args: Parameters<ProjectApi[M]>) => ReturnType<ProjectApi[M]>;
  // The boundary: replacing a method on an object by a computed key is what
  // every copy of this did, and TypeScript cannot express "the same signature"
  // through `M` without it. Both casts are between the method's own parameter
  // and return types, taken from `ProjectApi[M]` itself, so a wrong `method`
  // is still a compile error at the call site.
  const perform = (api[method] as Call).bind(api);
  api[method] = ((...args: Parameters<ProjectApi[M]>) => {
    recorded.push(of === undefined ? args : of(...args));
    return perform(...args);
  }) as ProjectApi[M];
  return recorded;
}
