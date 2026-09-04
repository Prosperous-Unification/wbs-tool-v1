/**
 * The suites that need no DOM, and therefore no jsdom.
 *
 * fe-01's whole suite is a **69-second** jsdom run, which is not an inner-loop
 * answer. These are the files that import no component and touch no browser
 * global, so they run under `--environment node` — see `vitest.node.config.ts`
 * and the `test:unit` target.
 *
 * **A list rather than a suffix, and that is a deviation from the plan.** W1-4
 * asked for `*.dom.test.tsx` across 55 files. A list costs nothing to read, no
 * rename, and no churn in every other change's diff — and the objection to it,
 * that a list goes stale, is answered by `src/test-tiers.test.ts` walking the
 * directory and refusing to let this disagree with the evidence in the files.
 * be-01's own tiering learned that the guard is the part that matters: it
 * caught its own first draft's mistake.
 *
 * Paths are relative to `apps/fe-01`, which is where both configs run.
 */
export const NODE_SUITES: readonly string[] = [
  'playwright-config.test.ts',
  'src/components/wbs/column-hints.test.ts',
  'src/components/wbs/dep-graph.test.ts',
  'src/components/wbs/dep-picker.test.ts',
  'src/components/wbs/depends-input.test.ts',
  'src/components/wbs/drag-drop.test.ts',
  'src/components/wbs/estimate-draft.test.ts',
  'src/components/wbs/gantt-geometry.test.ts',
  'src/components/wbs/initials.test.ts',
  'src/components/wbs/mention.test.ts',
  'src/components/wbs/name-notes.test.ts',
  'src/components/wbs/plan-completeness.test.ts',
  'src/components/wbs/pointed-row-store.test.ts',
  'src/components/wbs/project-picker.test.ts',
  'src/components/wbs/short-date.test.ts',
  'src/components/wbs/wbs-rows.test.ts',
  // Not `src/lib/api.test.ts`: `websocketUrl` reads `location`, so one of its
  // cases needs a browser after all. It is the file the plan's own measurement
  // named as the exception, and the guard below asserts it stays one.
  'src/lib/refusal.test.ts',
  // Of saved-plans' four `src/lib` suites this is the only one the tier rule
  // reads as DOM-free, and the other three are excluded by that rule rather
  // than by taste: `saved-plan-save.test.ts` and `saved-plan-shelf.test.ts`
  // import `@testing-library` and run under jsdom for real, and
  // `saved-plan-api.test.ts` is caught by `DOM_EVIDENCE`'s deliberately
  // generous `\bdocument\b` — fourteen prose mentions of the *OpenAPI*
  // document, no browser global at all. That is the safe direction to be
  // wrong in, as the rule's own comment says, so it is left where the rule
  // puts it rather than special-cased.
  'src/lib/saved-plan-compare.test.ts',
  'src/test-tiers.test.ts',
  'src/testing/record-calls.test.ts',
];
