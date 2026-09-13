import { expect, type Locator } from '@playwright/test';

/**
 * Puts the caret at the end of the focused field's line, on the platform the
 * browser is actually running on.
 *
 * **`End` is not that key on a Mac**, and a spec that presses it there is
 * pressing nothing. Measured in this suite's own Chromium on darwin, on a
 * `<textarea>` holding `Row 0000`:
 *
 * | after                     | `selectionStart` |
 * | ------------------------- | ---------------- |
 * | `focus()`                 | 0                |
 * | `press('End')`            | **0**            |
 * | `press('Meta+ArrowRight')`| 8                |
 *
 * macOS gives `End` to the *document* — it scrolls — and puts end-of-line on
 * ⌘→. On Linux, which is what CI runs, `End` is end-of-line and ⌘ is not a
 * modifier at all. So this is a real difference between the two platforms
 * rather than a Playwright detail, and `ControlOrMeta` does **not** paper over
 * it: `Control+ArrowRight` on Linux moves by a word, which for `Row 0000`
 * stops at 3 rather than 8.
 *
 * The consequence when a spec gets this wrong is not a red test on the Mac and
 * a green one on CI — it is worse than that. The caret stays at 0, the text
 * that follows is typed at the **start** of the field, and the failure reads
 * `Expected: "Row 0000 half-typed" · Received: " half-typedRow 0000"`, which
 * looks exactly like a race and was diagnosed as one before it was measured.
 *
 * `process.platform` and not `navigator.platform`: this decides which key the
 * **runner** sends, and Playwright runs the browser on the runner's own OS in
 * both places this suite runs.
 */
export async function caretToLineEnd(field: Locator): Promise<void> {
  await expect(
    field,
    'the caret cannot be moved in a field that has not got the focus',
  ).toBeFocused();
  await field.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
}
