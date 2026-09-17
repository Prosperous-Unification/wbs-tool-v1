import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';
import { measureInk, NAMELESS_CHROMA_FOR_GREY_INK } from './measure-ink';

/**
 * The Slack column's two faces, measured by the engine that paints them.
 *
 * The column prints a figure for a row with slack to spare and the word
 * `critical` for a row with none, and the second is set as a tag. Whether that
 * tag carries a hue is a fact about a stylesheet resolving `color-mix` in oklab
 * and about what Chromium composites it over — jsdom computes no colours at all,
 * so `wbs-table.test.tsx` can see the attribute arrive and can never see what it
 * is worth (R5 #14/#15/#17).
 *
 * Read through a canvas rather than off the string `getComputedStyle` answers
 * with, for `priority-ramp.spec.ts`' reason: a token resolves to `oklch(…)` and a
 * `color-mix` to `oklab(…)`, and a claim about a **margin** cannot be made
 * against either serialisation.
 *
 * `openspec/changes/quiet-critical-slack/`.
 */

/** The row of the plan holding this work item number, on the table face. */
const rowOf = (page: Page, number: string): Locator =>
  page.locator('tbody tr').filter({ has: page.getByLabel(`Name of ${number}`) });

/** That row's Slack cell — the `<span>` inside it, which is what carries the paint. */
const slackOf = (page: Page, number: string): Locator =>
  rowOf(page, number).locator('td[data-column="float"] [data-float]');

/**
 * A grey figure **on the same row** as the tag, which is the ground the tag has
 * to stand out from.
 *
 * The Start column's own figure: `--muted-foreground` on nothing, so what
 * `measureInk` composites under it is the row's band and nothing else.
 *
 * **The other row will not do, and that is a check that could not fail.** The
 * first cut of `still a tag` compared the tag's ground against the *slack* row's,
 * and rows alternate a band — so the two grounds differ by the stripe whether the
 * tag paints a ground or not. Watched: with `background` deleted from the rule
 * entirely, both palettes **passed**. `estimate-triple-visible`'s rule, third
 * hat: assert in the window the fault lives in, which for one element's own
 * ground is one row.
 */
const groundBesideIt = (page: Page, number: string): Locator =>
  rowOf(page, number).locator('td[data-column="start"] [data-start]');

/**
 * The longer of the two estimates, on the row that ends the plan.
 *
 * Two independent roots and no dependency between them: the longer one is the
 * critical path all by itself, and the shorter one has the difference as slack.
 * A chain would do as well and would put **both** its rows on the critical path,
 * leaving nothing on screen to compare the tag against — which is the comparison
 * the requirement is written as.
 */
const LONGER = '5/5/5';

/** The shorter one, four workdays inside the plan's own finish. */
const SHORTER = '1/1/1';

/** The row numbers the two estimates are typed onto. */
const CRITICAL_ROW = '010';
const SLACK_ROW = '020';

/**
 * How much colour the tag's ground may add to the ground beside it.
 *
 * **A distance in OKLab's a/b plane, and it took three goes to get there.**
 * Neither obvious measure works across this pair of palettes:
 *
 * - A **chroma ceiling** cannot. The dark palette's own background carries a
 *   hue, so an ordinary cell's composited ground measures chroma **0.0405** —
 *   more than the 12% `--destructive` tint's **0.0325**. The red tint *lowers*
 *   chroma there, and a ceiling would pass it. Watched: 0.015 failed the shipped
 *   grey on `Received: 0.04157914303556483`, dark palette, with nothing wrong.
 * - A **hue window** cannot. In the light palette the ordinary ground is chroma
 *   **0.0011**, where hue is quantisation noise: 197° measured, against the grey
 *   tag's 248°. Two near-neutrals 50° apart are the same colour.
 *
 * The distance between the two grounds' `(a, b)` is what "a tint was mixed in"
 * actually means, and it separates cleanly in both. Measured on this branch,
 * against the ground beside it: the shipped grey tint lands at **0.006925** light
 * and **0.000972** dark; the `--destructive` tint it replaced at **0.026692**
 * light and **0.024839** dark.
 */
const NAMELESS_TINT_GAP = 0.015;

/**
 * How far apart two measured grounds are in OKLab's a/b plane.
 *
 * `oklch` is polar, and a polar comparison of two low-chroma colours is a
 * comparison of two noisy angles — see {@link NAMELESS_TINT_GAP}. Back in
 * Cartesian terms the answer is the length of the colour that was added, which is
 * the claim being made.
 */
function tintGapOf(
  one: { chroma: number; hue: number },
  other: { chroma: number; hue: number },
): number {
  const cartesian = (polar: { chroma: number; hue: number }): [number, number] => [
    polar.chroma * Math.cos((polar.hue * Math.PI) / 180),
    polar.chroma * Math.sin((polar.hue * Math.PI) / 180),
  ];
  const [a, b] = cartesian(one);
  const [c, d] = cartesian(other);
  return Math.hypot(a - c, b - d);
}

/**
 * What the tag's legibility is held to, and why it is not WCAG's 4.5.
 *
 * The tag is small text — 10px at weight 600, under the 14pt-bold line where the
 * large-text case begins — so 4.5 is the figure it ought to answer to. It cannot,
 * and neither can the column: **the ordinary slack figure beside it measures
 * 4.4775:1** in the light palette, because `--muted-foreground` on `--background`
 * is 4.48 and nothing the tag does can improve on the ink the requirement makes
 * it share. A bar the subject of the test fails by construction is not a bar; it
 * was watched failing on `expected 3.8684939564563 to be greater than or equal to
 * 4.5` with a correct tag on screen.
 *
 * So the claim is the one actually available: the tag's tint may cost it no more
 * than a fifth of the legibility the column already has, and it never goes under
 * {@link READABLE_AT_ALL}. Measured: 3.8685 against the figure's 4.4775 in the
 * light palette (86%), 6.5930 against 7.4946 in the dark one (88%).
 */
const AT_WORST_A_FIFTH = 0.8;

/** The floor the tag never goes under, whatever the column above it is doing. */
const READABLE_AT_ALL = 3;

/** The one button in the header that opens the account menu — `dark-mode.spec.ts`' locator. */
const accountTrigger = (page: Page): Locator => page.locator('header button[aria-haspopup="menu"]');

/**
 * Waits for the palette flip's colour transitions to finish interpolating.
 *
 * `dark-mode.spec.ts`' `settled`, quoted there in full: a `getComputedStyle` read
 * taken inside the ~150ms transition answers with an interpolated colour neither
 * palette names.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.playState !== 'finished' && a.playState !== 'idle').length,
      ),
    )
    .toBe(0);
}

/** Opens the account menu, takes the palette asked for, and lets the paint land. */
async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await accountTrigger(page).click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await settled(page);
}

/**
 * Opens the fixed local identity and makes a plan of one critical row and one
 * row with slack.
 *
 * The wait at the end is on the **shorter** row's cell holding a figure, which
 * only the round trip can produce: an unestimated plan prints `—` in every Slack
 * cell, and a measurement taken in that window is a measurement of the wrong
 * element entirely (`estimate-triple-visible` — assert in the window the fault
 * lives in).
 */
async function seedPlan(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  // Through the shared fixture: a create arms a rename on the bar one round trip
  // after the table appears, so a fixture that types on into the plan can have
  // the keyboard pulled back to the header mid-flight. `create-project.ts` says
  // the whole of it.
  await createProject(page);
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of [CRITICAL_ROW, SLACK_ROW]) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  for (const [number, estimate] of [
    [CRITICAL_ROW, LONGER],
    [SLACK_ROW, SHORTER],
  ] as const) {
    const box = page.getByLabel(`Dev estimate for ${number}`);
    await box.fill(estimate);
    await box.blur();
    await expect(box).not.toHaveValue('');
  }

  await expect(
    slackOf(page, CRITICAL_ROW),
    'the longer row never became the critical path',
  ).toHaveAttribute('data-critical', 'true');
  await expect(
    slackOf(page, SLACK_ROW),
    'the shorter row never got a slack figure to compare the tag against',
  ).not.toHaveAttribute('data-critical', 'true');
}

test.describe('a critical row’s slack', () => {
  for (const palette of ['Light', 'Dark'] as const) {
    test(`is a grey tag rather than a red one in the ${palette.toLowerCase()} palette`, async ({
      page,
    }) => {
      await seedPlan(page);
      await chooseTheme(page, palette);

      const tag = await measureInk(slackOf(page, CRITICAL_ROW));
      const figure = await measureInk(slackOf(page, SLACK_ROW));
      const beside = await measureInk(groundBesideIt(page, CRITICAL_ROW));

      // Proof: `styles.css`'s `[data-grid] [data-float][data-critical]` left on
      // `color: var(--destructive)`, watched failing here on `the critical tag's
      // ink carries a hue · Expected: < 0.09 · Received: 0.23866607416984745`
      // in the light palette and `0.18922641250344935` in the dark one.
      expect(tag.chroma, "the critical tag's ink carries a hue").toBeLessThan(
        NAMELESS_CHROMA_FOR_GREY_INK,
      );

      // And the ground under it, which is the other half of a red tag: an ink
      // measured alone passes with the lettering greyed and the tint left red.
      //
      // Proof: the same rule's `background` put back on
      // `color-mix(in oklab, var(--destructive) 12%, var(--background))` with the
      // grey ink kept, watched failing here on `the critical tag's ground has a
      // tint mixed into it · Expected: < 0.015 · Received: 0.026692250029499404`
      // in the light palette and `0.02483930165071019` in the dark one.
      expect(
        tintGapOf(tag.surface, beside.surface),
        "the critical tag's ground has a tint mixed into it",
      ).toBeLessThan(NAMELESS_TINT_GAP);

      // The same ink as the figures it stands among — the requirement's own words,
      // and what makes "quiet" mean the column's ink rather than any grey at all.
      //
      // Proof: the rule's `color` set to
      // `color-mix(in oklab, var(--foreground) 40%, var(--background))` — a grey
      // that clears the chroma ceiling above — watched failing on `the tag's ink
      // is not the column's ink · Expected: 0.5541629781808084 · Received:
      // 0.6524588994008041` in the light palette and `0.7038202552146958` against
      // `0.47062583090898713` in the dark one.
      expect(tag.lightness, "the tag's ink is not the column's ink").toBeCloseTo(
        figure.lightness,
        2,
      );
      expect(tag.chroma).toBeCloseTo(figure.chroma, 2);

      // Still a tag, not a word: it paints a ground of its own, so a reader does
      // not read `critical` down the column as though it were a number. Quieter
      // is not invisible.
      //
      // Against {@link groundBesideIt} — the same row — for the reason written
      // there. Proof: `background` deleted from the rule, watched failing here on
      // `the tag lost the ground that tells it from a figure · Expected: > 0.01 ·
      // Received: 0` in both palettes. Against the *other* row's ground, the same
      // deletion was watched **passing**.
      expect(
        Math.abs(tag.surface.lightness - beside.surface.lightness),
        'the tag lost the ground that tells it from a figure',
      ).toBeGreaterThan(0.01);

      // And legible on it, which is the whole reason this is measured in a
      // browser: the tint is a `color-mix` the reader's palette decides, and what
      // it costs the ink is a number only a compositor knows.
      // {@link AT_WORST_A_FIFTH} says why the second bar is a proportion.
      expect(tag.contrast).toBeGreaterThanOrEqual(READABLE_AT_ALL);
      expect(
        tag.contrast,
        "the tag's own tint cost it more than a fifth of the column's legibility",
      ).toBeGreaterThan(figure.contrast * AT_WORST_A_FIFTH);
    });
  }
});
