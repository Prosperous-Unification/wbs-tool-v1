/**
 * The trimmed name, or `null` when there is nothing there to name.
 *
 * The one normalisation every named thing in the directory and every step goes
 * through, so `"  Dev  "`, `"Dev"` and `"Dev "` are one name and a name of only
 * spaces is refused rather than stored. Two identical copies stood in
 * `directory.service.ts` and `step.service.ts` until 2026-09-02; a third rule
 * with the same tail lives in `work-item.routes.ts` and is deliberately
 * **not** this one — it also enforces a length ceiling and belongs at the
 * request boundary.
 *
 * `null` rather than a throw because an empty name is a modeled refusal every
 * caller answers as a 400, not an invariant failure.
 */
export function cleanName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}
