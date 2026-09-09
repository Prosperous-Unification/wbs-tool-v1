import { expect, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The ref column, measured by a browser.
 *
 * Everything here is a fact jsdom cannot state, and design D2's central claim is
 * the first of them: the marks are absolutely positioned inside a fixed-height
 * box, so a row wired to four systems and a row wired to none are the same
 * height and their cells are the same width. jsdom computes no layout, so every
 * one of the 565 cases in `wbs-table.test.tsx` would stay green with the marks
 * put back into normal flow — which is the fault this file exists to see.
 *
 * The second is the palette: a colour is a string to jsdom, so "every mark is
 * legible on both grounds" is a claim only an engine that rasterises can make.
 */

/** One JSON POST through the page's own session, so the API sees a signed-in reader. */
async function jsonPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  return page.evaluate(
    async ({ at, value }) => {
      const response = await fetch(at, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error(`POST ${at} failed: ${String(response.status)}`);
      return response.json() as Promise<T>;
    },
    { at: path, value: body },
  );
}

/** One batch on a project, answering the id each command created (by index). */
async function commands(
  page: Page,
  projectId: string,
  list: Record<string, unknown>[],
): Promise<(string | undefined)[]> {
  const answer = await jsonPost<{ results: { id?: string }[] }>(
    page,
    `/api/projects/${projectId}/commands`,
    { commands: list },
  );
  return answer.results.map((each) => each.id);
}

interface Seed {
  projectId: string;
  /** The vocabulary as be-01 seeded it, by canonical name. */
  systemOf: Record<string, string>;
}

/**
 * Two rows: `010` wired to four systems and a `javascript:` URL, `020` wired to
 * nothing at all.
 *
 * The refs are written **through the API** rather than typed into the editor,
 * and for `reference-cells.spec.ts`' reason plus one of this file's own: the
 * `javascript:` URL is the fault the scheme guard exists for, and it arrives
 * the way it really would — from a peer, or a script, through a be-01 that
 * deliberately does not refuse a scheme at the write (a reader may override a
 * derived type, so a mismatch has to stay storable).
 */
async function seed(page: Page): Promise<Seed> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);

  await expect.poll(() => page.evaluate(() => localStorage.getItem('wbs.project'))).not.toBeNull();
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id after creating the plan');

  const vocabulary = await page.evaluate(async () => {
    const response = await fetch('/api/external-systems');
    return response.json() as Promise<{ externalSystems: { id: string; name: string }[] }>;
  });
  const systemOf = Object.fromEntries(
    vocabulary.externalSystems.map((system) => [system.name, system.id]),
  );
  // The vocabulary is seeded, not empty: these five are what `systemOfUrl`
  // answers, and a run against a be-01 that had seeded none would measure marks
  // that all drew as `other` while claiming to measure four systems.
  const seeded = new Set(vocabulary.externalSystems.map((system) => system.name));
  for (const name of ['jira-issue', 'github-pr', 'confluence-page', 'slack-message']) {
    if (!seeded.has(name)) throw new Error(`be-01 seeded no ${name}`);
  }

  // Placed by `ref`/`afterRef` rather than by two `afterId: null`s. Both of
  // those insert at the **front**, so the second row created is the one
  // numbered `010` — and every assertion below would then be about the row it
  // names and the refs of the other one. Found in Chromium, not reasoned about:
  // the card never opened, because `010` was the row with no links.
  const [first] = await commands(page, projectId, [
    {
      kind: 'createWorkItem',
      ref: 'wired',
      parentId: null,
      afterId: null,
      name: 'Wired to four systems',
    },
    { kind: 'createWorkItem', parentId: null, afterRef: 'wired', name: 'Wired to nothing' },
  ]);
  if (first === undefined) throw new Error('the first row was not created');

  await commands(page, projectId, [
    {
      kind: 'patchWorkItem',
      workItemId: first,
      patch: {
        externalRefs: [
          // Two named and two not, so one card holds both readings: the words a
          // reader typed, and `refLabelOf(url)` where nobody has typed any.
          {
            systemId: systemOf['jira-issue'],
            url: 'https://acme.atlassian.net/browse/AB-1',
            name: 'AB-1 Strip the walls',
          },
          { systemId: systemOf['confluence-page'], url: 'https://acme.atlassian.net/wiki/spec' },
          {
            systemId: systemOf['github-pr'],
            url: 'https://github.com/acme/tool/pull/7',
            name: '#7 Rewire the shed',
          },
          { systemId: systemOf['slack-message'], url: 'https://acme.slack.com/archives/C1/p1' },
          // The fault the scheme guard exists for, stored the way it really
          // arrives. It rides on an existing system so that it is a *link* the
          // renderer has to refuse, not a ref the store refused first.
          { systemId: systemOf['jira-issue'], url: 'javascript:alert(1)' },
        ],
      },
    },
  ]);
  await page.reload();
  // A linked project still starts from the data-independent baseline. Wait for
  // the whole tree to land, then use the same one-time Reset layout gesture a
  // reader uses to opt into the contextual target.
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset layout' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect(page.getByLabel('Links for 010')).toBeVisible();
  return { projectId, systemOf };
}

/** Opens the account menu, takes the palette asked for, and lets the paint land. */
async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  // Every surface carries `transition-colors`, so a read taken inside the flip
  // answers with an interpolated colour neither palette names — `dark-mode.spec.ts`
  // measured 1.03:1 for a link whose resting ratio is 15.9:1.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getAnimations().filter((each) => each.playState === 'running').length,
      ),
    )
    .toBe(0);
}

/**
 * What each mark is painted, and what it stands on, as WCAG counts the two.
 *
 * The mark's **paint** rather than its text colour: a filled mark is its
 * `background-color` and a ring is its `border-top-color`, which is the whole
 * fill/hue split of design D3 read back off the page. Rasterised through a
 * canvas rather than parsed, for `dark-mode.spec.ts`' reason — `oklch(…)` and
 * `oklab(…)` cannot be turned into a luminance by reading the string, and a
 * colour this engine refuses leaves `fillStyle` where it was, so the sentinel
 * is what makes that loud instead of silently measuring the last colour again.
 */
function markContrasts(page: Page): Promise<{ kind: string; ratio: number; area: number }[]> {
  return page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d context to rasterise a colour in');
    const rgbaOf = (colour: string): [number, number, number, number] => {
      const sentinel = '#ff00ff';
      ctx.fillStyle = sentinel;
      ctx.fillStyle = colour;
      if (ctx.fillStyle === sentinel) throw new Error(`this engine will not parse ${colour}`);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const painted = ctx.getImageData(0, 0, 1, 1).data;
      return [painted[0], painted[1], painted[2], painted[3] / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const luminance = (colour: [number, number, number]): number => {
      const channel = (raw: number): number => {
        const unit = raw / 255;
        return unit <= 0.03928 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
      };
      return (
        0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2])
      );
    };
    const surfaceUnder = (node: Element): [number, number, number] => {
      const stacked: [number, number, number, number][] = [];
      let ancestor: Element | null = node.parentElement;
      while (ancestor !== null) {
        const painted = rgbaOf(getComputedStyle(ancestor).backgroundColor);
        if (painted[3] > 0) stacked.push(painted);
        if (painted[3] === 1) break;
        ancestor = ancestor.parentElement;
      }
      let surface: [number, number, number] = [255, 255, 255];
      for (const layer of stacked.reverse()) surface = over(layer, surface);
      return surface;
    };
    return [...document.querySelectorAll<HTMLElement>('[data-ref-mark]')].map((mark) => {
      const style = getComputedStyle(mark);
      const filled = rgbaOf(style.backgroundColor)[3] > 0;
      const paint = rgbaOf(filled ? style.backgroundColor : style.borderTopColor);
      const surface = surfaceUnder(mark);
      const ink = over(paint, surface);
      const [brighter, dimmer] = [luminance(ink), luminance(surface)].sort((a, b) => b - a);
      const box = mark.getBoundingClientRect();
      return {
        kind: mark.dataset['refMark'] ?? '',
        ratio: (brighter + 0.05) / (dimmer + 0.05),
        area: box.width * box.height,
      };
    });
  });
}

/** What WCAG asks of a graphical object, which is what a 6px dot is. */
const READABLE_MARK = 3;

test.describe('the ref column, in a browser', () => {
  test('four marks stand inside the cell, and move neither the row nor the column', async ({
    page,
  }) => {
    // Design D2's claim: the marks are placed out of flow in a fixed-height box,
    // so neither their number nor their absence moves anything.
    //
    // **The row-height half of that claim cannot fail, and saying so is the
    // point of this comment.** The ref cell's box is 12px inside a row the Name
    // cell already stands 26.19px tall — measured, 2026-08-31 — so the row is
    // never this cell's to move, and the equality below is a true statement
    // this design could not break. It is kept because the spec asks for it, and
    // it is not what the injected fault is watched against.
    //
    // What the fault really does is collapse the marks: a `<span>` in normal
    // flow is inline, width and height do not apply to it, and four 6px discs
    // become four zero-width text boxes standing outside the 12px box they were
    // meant to sit in.
    //
    // Proof: `markStyle`'s `position: 'absolute'` changed to `'static'` and the
    // rows measured — the height assertion **passed** (26.1875 either way, the
    // marks reported as `[164,150,0,15]`), and this failed on `jira is not a
    // 6×6 disc · Expected {"height": 6, "width": 6} · Received {"height": 15,
    // "width": 0}`. Watched, 2026-08-31.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    const measured = await page.evaluate(() => {
      const cellOf = (number: string): HTMLElement => {
        const cell = document.querySelector<HTMLElement>(`[aria-label="Links for ${number}"]`);
        if (cell === null) throw new Error(`no links cell on ${number}`);
        return cell;
      };
      const rowOf = (number: string): DOMRect => {
        const row = cellOf(number).closest('tr');
        if (!(row instanceof HTMLElement)) throw new Error(`no row for ${number}`);
        return row.getBoundingClientRect();
      };
      const tdOf = (number: string): DOMRect => {
        const td = cellOf(number).closest('td');
        if (!(td instanceof HTMLElement)) throw new Error(`no cell for ${number}`);
        return td.getBoundingClientRect();
      };
      // The marks' own 12px box, not the button. The button fills the whole
      // `<td>` since 2026-09-09 (Dany: *"i want hover over the whole cell
      // surface to trigger the tooltip"*), so measuring containment against it
      // would be a claim the design cannot break — the marks are its children
      // however they are placed.
      const marksBox = cellOf('010').querySelector('[data-ref-marks-box]');
      if (marksBox === null) throw new Error('no marks box in the links cell');
      const box = marksBox.getBoundingClientRect();
      return {
        wiredRow: rowOf('010').height,
        bareRow: rowOf('020').height,
        wiredCell: tdOf('010').width,
        bareCell: tdOf('020').width,
        box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
        marks: [...cellOf('010').querySelectorAll<HTMLElement>('[data-ref-mark]')].map((mark) => {
          const rect = mark.getBoundingClientRect();
          return {
            kind: mark.dataset['refMark'] ?? '',
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            right: rect.right,
          };
        }),
      };
    });

    // Or this is a check about a cell that drew nothing: four systems and a
    // fifth ref into one of them, so four marks and no overflow.
    expect(measured.marks.map((mark) => mark.kind)).toEqual([
      'jira',
      'confluence',
      'github',
      'slack',
    ]);
    for (const mark of measured.marks) {
      // Every mark is the disc the design draws, at the size the column was
      // costed for. This is the assertion the normal-flow fault is watched
      // against.
      expect({ width: mark.width, height: mark.height }, `${mark.kind} is not a 6×6 disc`).toEqual({
        width: 6,
        height: 6,
      });
      // And it sits inside the fixed box, rather than escaping it downward the
      // way an inline one does.
      expect(mark.top, `${mark.kind} sits above its box`).toBeGreaterThanOrEqual(measured.box.top);
      expect(mark.bottom, `${mark.kind} hangs below its box`).toBeLessThanOrEqual(
        measured.box.bottom,
      );
      expect(mark.right, `${mark.kind} runs past the cell`).toBeLessThanOrEqual(measured.box.right);
    }
    // The spec's own two equalities. Both hold, and neither is load-bearing —
    // see the note at the top of this test.
    expect(measured.wiredRow, 'the two rows are not the same height').toBe(measured.bareRow);
    expect(measured.wiredCell, 'the two cells are not the same width').toBe(measured.bareCell);
    // And the column really is the 40px the width table declares, or "the same
    // width" is two cells agreeing about a number nobody chose.
    expect(measured.wiredCell).toBe(40);
  });

  test('the heading is a drawn link, and the column is ruled off from the name', async ({
    page,
  }) => {
    // Dany, 2026-08-31, from a screenshot: "maybe add a vertical line separator
    // to links, also maybe change the column header to link symbol". The word
    // `LINKS` is five characters of 10px all-caps in a 40px column, so it ran
    // under `NAME`; and with no rule after it, an empty Links column and the
    // Name column read as one undivided field.
    //
    // **Both halves need a browser.** jsdom applies no stylesheet, so the rule
    // is invisible to it, and it lays out no text, so it cannot see a heading
    // overflow its column.
    await seed(page);

    const heading = page.locator('th[data-column="refs"]');
    // The word is gone from the ink and still there for a reader who is not
    // looking at ink: an `aria-hidden` icon alone would leave this column
    // heading announcing nothing, and a heading is what names every cell below.
    await expect(heading).toHaveAccessibleName(/Links/);
    expect(await heading.locator('svg').count(), 'the heading draws no link glyph').toBeGreaterThan(
      0,
    );

    // Nothing visible sticks out of the 40px the column declares. `sr-only` is
    // clipped to a 1px box, so it is the icon this measures.
    const box = await heading.boundingBox();
    const drawn = await heading.locator('svg').first().boundingBox();
    if (box === null || drawn === null) throw new Error('the refs heading has no box');
    expect(box.width).toBe(40);
    expect(drawn.width, 'the drawn link has no width').toBeGreaterThan(0);
    expect(drawn.x).toBeGreaterThanOrEqual(box.x);
    expect(drawn.x + drawn.width).toBeLessThanOrEqual(box.x + box.width);

    // And the rule. It is an `inset` box-shadow rather than a border, because a
    // border would take a pixel the column's measured width does not include —
    // the same reason `styles.css` draws every separator in this table this way.
    //
    // Proof: `[data-column='refs']` taken back out of that selector list, this
    // failed on `Expected substring: "-1px -1px" · Received string:
    // "oklch(0.929 0.013 255.508) 0px -1px 0px 0px inset"` — the horizontal
    // rule every cell in the table already has, and no vertical one beside it.
    // Watched in Chromium, 2026-08-31.
    const ruled = (which: 'th' | 'td') =>
      page
        .locator(`${which}[data-column="refs"]`)
        .first()
        .evaluate((node) => getComputedStyle(node).boxShadow);
    for (const which of ['th', 'td'] as const) {
      expect(
        await ruled(which),
        'the refs column is not ruled off from the name beside it',
      ).toContain('-1px -1px');
    }
  });

  test('the same at 390×844, where the plan is cards rather than a table', async ({ page }) => {
    await seed(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // The phone renders the plan as cards, which have no ref column at all —
    // stated as an assertion rather than assumed, because a silently absent cell
    // is how a measurement of nothing passes. The claim this test can make at
    // this width is the table's, so the viewport is taken back to a width that
    // has one and the marks are measured there.
    // The card list has to be **on screen** before anything is counted.
    // `setViewportSize` does not flush React's re-render, and the first version
    // of this read the DOM straight after it — counting the table that had not
    // been unmounted yet. It flaked in the whole-gate run of 2026-08-31 on
    // `Expected: 0 · Received: 1` and passed twice on its own afterwards, which
    // is the signature: an assertion made before the render it is about, not a
    // ref column on a phone. `Plan actions` is the control the table's `Add
    // work item` becomes, so it is on screen exactly when the cards are.
    //
    // Proof: `CARDS_BELOW` in `plan-renderer.ts` dropped from 768 to 0, so the
    // **table** renders at 390 — this line failed on `expect(locator)
    // .toBeVisible() failed · Locator: getByRole('button', { name: 'Plan
    // actions' }) · element(s) not found`. Watched in Chromium, 2026-08-31.
    await expect(page.getByRole('button', { name: 'Plan actions' })).toBeVisible();
    // The count the test is named for, and it is **not** what the injection
    // above is watched by: with the table rendered at 390 the line before this
    // one stops the test first. Said plainly rather than left to look proven —
    // the fault this one is for is the other one, a card that grows a `Links
    // for …` control of its own (`mobile-card-facts` decides what a card
    // carries, and today it carries no refs). A retrying count rather than a
    // one-shot `evaluate`, for the render-timing reason above.
    await expect(page.getByLabel('Links for 010')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByLabel('Links for 010')).toBeVisible();
    const heights = await page.evaluate(() => {
      const rowOf = (number: string): number => {
        const row = document
          .querySelector<HTMLElement>(`[aria-label="Links for ${number}"]`)
          ?.closest('tr');
        if (!(row instanceof HTMLElement)) throw new Error(`no row for ${number}`);
        return row.getBoundingClientRect().height;
      };
      return { wired: rowOf('010'), bare: rowOf('020') };
    });
    expect(heights.wired).toBe(heights.bare);
  });

  for (const palette of ['Light', 'Dark'] as const) {
    test(`every mark is legible in the ${palette.toLowerCase()} palette`, async ({ page }) => {
      // Design D3's own claim, and the reason the neutrals are tokens rather
      // than colours: `currentColor` is near-black on a light page and
      // near-white on a dark one, so the GitHub mark is the one that would
      // disappear if it were written as a hex.
      //
      // Proof: `FAMILY_PAINT.github` set to a literal `oklch(0.2 0 0)` — the
      // near-black a hex would have pinned — and the dark half of this failed
      // on `github is not legible on this ground · Expected: >= 3 · Received:
      // 1.1138806212915524`, with the light half still green. Watched,
      // 2026-08-31.
      await seed(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await chooseTheme(page, palette);

      const marks = await markContrasts(page);
      expect(marks.map((mark) => mark.kind)).toEqual(['jira', 'confluence', 'github', 'slack']);
      for (const mark of marks) {
        // A mark with no area is a mark nobody can see, and a ratio about it is
        // a ratio about nothing — `G gantt-view`'s zero-width bar, one column
        // over.
        expect(mark.area, `${mark.kind} is painted nothing at all`).toBeGreaterThan(0);
        expect(mark.ratio, `${mark.kind} is not legible on this ground`).toBeGreaterThanOrEqual(
          READABLE_MARK,
        );
      }
    });
  }

  test('a stored javascript: URL never becomes an href, on either surface', async ({ page }) => {
    // The scheme guard, in the engine that would actually run the URL. The ref
    // is stored through the API above, so nothing on the way in refused it and
    // the renderer is the only thing standing between it and a navigation.
    //
    // Proof: `followableHref` made to return its argument unconditionally, this
    // failed on `expect(locator).toHaveCount(expected) failed · Expected: 4 ·
    // Received: 5` at the card — one `a[data-refs-card-url]` more than the four
    // http refs. Watched, 2026-08-31.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card).toBeVisible();
    // Five refs, four of them followable: the anchors are the http ones, and
    // the fifth is on the page as text.
    await expect(card.locator('a[data-refs-card-url]')).toHaveCount(4);
    await expect(card.locator('span[data-refs-card-url]')).toHaveText(['javascript:alert(1)']);
    for (const href of await card
      .locator('a[data-refs-card-url]')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''))) {
      expect(href).toMatch(/^https?:/);
    }
    // No anchor anywhere on the page carries it — the assertion the card's own
    // count cannot make, because a guard that wrote the href onto a *different*
    // element would still leave the card holding four.
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);

    // And the editor, which is the other surface the rule is about.
    await page.getByLabel('Links for 010').click();
    const editor = page.getByRole('dialog', { name: 'Links for 010' });
    await expect(editor).toBeVisible();
    await expect(editor.locator('a[data-refs-editor-url]')).toHaveCount(4);
    await expect(editor.locator('span[data-refs-editor-url]')).toHaveText(['javascript:alert(1)']);
  });

  test('the card is drawn on top of the rows below it, not under them', async ({ page }) => {
    // **The fault this whole change started from, and only a browser can see
    // it.** The Links column is pinned, a pinned cell is `position: sticky`
    // *with* a `z-index`, and that makes it a stacking context — so the card
    // inside it was trapped there and the Name cell beside it painted straight
    // over it. The card was in the DOM, the right size, in the right place, and
    // invisible: measured in Chromium on 2026-09-09 at `[94, 229, 284, 68]`
    // with `elementFromPoint` at its own middle answering the *next* row's name
    // `<textarea>`. Every one of the 2000-odd jsdom cases stayed green through
    // it, because jsdom paints nothing at all.
    //
    // **This test does not distinguish the lift, and that was measured rather
    // than assumed.** With `raiseWhenOpen` narrowed back to
    // `columnId === 'name'` it still **passes** — because the hover surface
    // this change also added is `position: absolute`, and an absolutely
    // positioned wrapper paints its own descendants late enough to keep the
    // card on top by itself. Two fixes, either sufficient, and the browser can
    // only see that the card is visible.
    //
    // So the negative for the lift is the jsdom one — `lifts the links cell
    // over the pinned layer while its card is open` in `plan-cells.test.tsx`,
    // watched failing on `expected 1 to be 2` — and this is the end-to-end
    // guarantee that no arrangement of the two leaves the card painted over.
    // The lift stays because it is the general rule: the Name column's own
    // 2026-08-08 fault is the same one, and that column has no absolutely
    // positioned wrapper to save it.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card).toBeVisible();

    const painted = await page.evaluate(() => {
      const found = document.querySelector('[role="tooltip"]');
      if (found === null) throw new Error('no card on the page');
      const box = found.getBoundingClientRect();
      // Or this is a claim about a box with nothing in it, which is
      // `G gantt-view`'s zero-width bar wearing a third hat.
      if (box.width === 0 || box.height === 0) throw new Error('the card has no area');
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        inside: at !== null && found.contains(at),
        instead: at === null ? 'nothing' : at.tagName,
        box: { width: box.width, height: box.height },
      };
    });
    expect(
      painted.inside,
      `the element painted at the middle of the card is not part of it: ${painted.instead}`,
    ).toBe(true);
  });

  test('a card line says what the link is called, and tints under the pointer', async ({
    page,
  }) => {
    // Dany, 2026-09-09: *"i can then hover over the dropdown and see the link's
    // summary + link to click to follow it"*. Two facts, and both are the
    // browser's: that the pointer can travel from a 6px dot onto the card
    // without the card closing, and that the line it comes to rest on is the
    // line that lights up.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card).toBeVisible();

    // The names a reader typed, and the labels their URLs carry where nobody
    // typed one. Asserted as the whole list rather than one line, because a
    // fallback that answered for every ref — named or not — would still make
    // any single assertion pass.
    await expect(card.locator('[data-refs-card-name]')).toHaveText([
      'AB-1 Strip the walls',
      'acme.atlassian.net/spec',
      '#7 Rewire the shed',
      'acme.slack.com/p1',
      'javascript:alert(1)',
    ]);

    // The travel, and then the tint. Read **while the pointer is on the line**,
    // which is the window the fault lives in: a colour read after the pointer
    // has moved on is a colour about nothing.
    //
    // Proof: the `[data-refs-card-line]:hover` rule deleted from `styles.css` —
    // this failed on `the pointed line of the card does not tint ·
    // Expected: not "rgba(0, 0, 0, 0)"`. Watched 2026-09-09.
    const line = card.locator('[data-refs-card-line]').first();
    const atRest = await line.evaluate((node) => getComputedStyle(node).backgroundColor);
    await line.hover();
    await expect(card, 'the card closed on the way to it').toBeVisible();
    const pointed = await line.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(pointed, 'the pointed line of the card does not tint').not.toBe(atRest);

    // And the link under the pointer is the one a click would follow. The name
    // is the anchor, which is what makes the line's own words the thing a
    // reader aims at.
    const name = card.locator('a[data-refs-card-name]').first();
    await expect(name).toHaveAttribute('href', 'https://acme.atlassian.net/browse/AB-1');
    await expect(name).toHaveAttribute('target', '_blank');
    await expect(name).toHaveAttribute('rel', 'noreferrer noopener');
  });

  test('a name typed into the editor is what the card then says', async ({ page }) => {
    // The whole round trip through the real stack: the editor states the list,
    // be-01 writes the column, the tree read carries it back and the card draws
    // it. The one assertion in this file that would fail if any single layer of
    // this change were missing.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel('Links for 010').click();
    const editor = page.getByRole('dialog', { name: 'Links for 010' });
    await expect(editor).toBeVisible();
    // The second link is the unnamed Confluence page, and its box shows the
    // derived label as a placeholder rather than as a value.
    const second = editor.getByLabel('Name of link 2');
    await expect(second).toHaveValue('');
    await expect(second).toHaveAttribute('placeholder', 'acme.atlassian.net/spec');

    await second.fill('The wiring spec');
    await second.blur();
    // **This box is uncontrolled, and it is still the answer's** — which is
    // worth stating, because an uncontrolled box normally holds what was typed
    // whatever the server said, and asserting on one is
    // `estimate-triple-visible`'s trap. What saves it here is that the store
    // mints a fresh `crypto.randomUUID()` per ref on every replacement, so a
    // write changes every `ref.id`, so the `key` changes, so React remounts the
    // input and its `defaultValue` is the name be-01 sent back.
    await expect(editor.getByLabel('Name of link 2')).toHaveValue('The wiring spec');

    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    // And the card, which reads the row rather than any box: this is the
    // assertion no keystroke could satisfy.
    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card.locator('[data-refs-card-name]').nth(1)).toHaveText('The wiring spec');
  });

  test('the pointer opens the card from anywhere in the cell, not just off a dot', async ({
    page,
  }) => {
    // Dany, 2026-09-09: *"i want hover over the whole cell surface to trigger
    // the tooltip"*. The hover target was a 28×12 button inside a 40×26 cell,
    // so a pointer resting in the column's own empty room got nothing — found
    // by hovering the column by hand and watching the card not open, twice,
    // before the button was measured.
    //
    // Both corners, because one of them is inside the old 28×12 box and the
    // other never was: the bottom-right of the cell is the room the button did
    // not cover.
    //
    // Proof, and it took three watched failures to get the mechanism right,
    // all on 2026-09-09:
    //   - the surface sized to the cell's **content** box: `the top left of the
    //     cell opened no card`, because `x + 1` is inside the `<td>`'s 4px
    //     horizontal padding.
    //   - the surface given `position: relative; height: 100%`: `the bottom
    //     right of the cell opened no card`, because Chromium does not resolve
    //     a percentage height against a `table-cell` and the box fell back to
    //     the marks' 12px.
    //   - the pointer parked 200px below the cell between cases: `the card
    //     stayed open after the pointer left it`, for 30s — that point is
    //     *inside* the card, which is a child of the span that owns the
    //     `mouseleave`. The design working, not failing.
    // With the surface back to `MARK_BOX_PX` tall the bottom-right case fails
    // again, which is the standing negative.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    const cell = page.locator('td[data-column="refs"]').first();
    const box = await cell.boundingBox();
    if (box === null) throw new Error('the links cell has no box');
    // Or this is a claim about a corner of nothing.
    expect(box.width, 'the links cell has no width').toBeGreaterThan(20);
    expect(box.height, 'the links cell has no height').toBeGreaterThan(20);

    // **The surface and the cell are the same rectangle**, which is the
    // mechanism the two corner cases exercise — and asserting it here is what
    // keeps the design's one assumption honest: the hover surface is
    // `position: absolute; inset: 0`, so it fills the nearest *positioned*
    // ancestor, and that is the `<td>` only because every cell in this column
    // is `position: sticky`. A layout change that unpinned the column would
    // move the surface somewhere else entirely, and this line is what would
    // say so.
    const surface = await page.getByLabel('Links for 010').boundingBox();
    if (surface === null) throw new Error('the links surface has no box');
    expect(
      {
        x: Math.round(surface.x),
        y: Math.round(surface.y),
        width: Math.round(surface.width),
        height: Math.round(surface.height),
      },
      'the hover surface is not the cell',
    ).toEqual({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });

    // A pixel in from each corner of the cell's **own** rectangle, padding
    // included. `CELL` gives every `<td>` `padding: 1px 4px`, so a surface
    // sized to the content box leaves a 4px strip down each side that arms
    // nothing — which is exactly what a hover at `x + 3` found before the
    // button was given negative margins.
    for (const [where, at] of [
      ['top left', { x: 1, y: 1 }],
      ['bottom right', { x: box.width - 1, y: box.height - 1 }],
    ] as const) {
      // Away first, and **waited on**, so each case opens the card rather than
      // finding one the previous case left open: the claim has to be about this
      // corner.
      //
      // **Away has to be clear of the card, not just of the cell**, and that
      // took two goes to get right. A one-shot `count()` read the card at the
      // instant of the move, before React had unmounted it (`Expected: 0 ·
      // Received: 1`). Waiting on it then failed for 30 seconds on the *second*
      // case — because a point 200px right and 200px down from a 40px cell is
      // inside the card itself: five refs make it about 185px tall, and the
      // card is a child of the span that owns the `mouseleave`, so resting on
      // it is resting on the cell. That is the design working, not failing.
      // `+800` clears the card's own 400px ceiling on a 1280px viewport.
      //
      // `toHaveCount(0)` is the retrying matcher `AGENTS.md` warns about, and
      // this is the one shape it is right for: the absence is a **precondition**
      // that holds until the pointer moves back, not a temporary silence being
      // asserted. The claim below is the `toBeVisible`.
      await page.mouse.move(box.x + 800, box.y + 5);
      await expect(card, 'the card stayed open after the pointer left it').toHaveCount(0);
      await page.mouse.move(box.x + at.x, box.y + at.y);
      await expect(card, `the ${where} of the cell opened no card`).toBeVisible();
    }
  });

  test('the pointer walks onto the card and follows a link', async ({ page, context }) => {
    // Dany, 2026-09-09: *"i want to then be able to hover over the tooltip to
    // click and go to the linked item"*. Every part of that is the browser's:
    // the card must survive the pointer leaving the cell, it must take the
    // pointer at all — it is `pointer-events: none` but for its lines — and the
    // click must really open the page.
    //
    // A real click and a real popup, not an `href` assertion: the card hangs
    // over the rows below, so "the anchor is there" and "the anchor is what the
    // pointer reaches" are two different facts, and `AGENTS.md`'s
    // `name-links-and-height` note is a proof that guessed the second one.
    //
    // Proof: `pointerEvents: 'auto'` removed from the card's line — this failed
    // on `page.waitForEvent: Test timeout of 120000ms exceeded while waiting
    // for event "page"`, no tab opened at all. Watched 2026-09-09.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card).toBeVisible();

    // **Walked, not teleported, and that is the whole of this test.**
    // `locator.hover()` puts the pointer straight on an element's centre, so it
    // never crosses the card's own 6px padding — and that padding was
    // `pointer-events: none`, so a real cursor hit-tested the row *beneath* the
    // card on its way in, fired the cell wrapper's `mouseleave`, and the card
    // vanished under the hand reaching for it. Dany found it in the running app
    // on 2026-09-09; this file's `.hover()` had passed over it twice.
    //
    // Proof: `takesPointer` taken off `ExternalRefsCard`'s `HoverCard` — this
    // failed on `the card closed on the way over to it`. Watched 2026-09-09
    // against **this** design; while a 200ms grace period was still in the cell
    // (since deleted) the same injection got as far as the padding probe one
    // assertion later and failed there instead. The guard that is gone was
    // hiding what this one is for.
    const cellBox = await page.getByLabel('Links for 010').boundingBox();
    const cardBox = await card.boundingBox();
    if (cellBox === null || cardBox === null) throw new Error('no box to walk between');
    // **The card opens beside the cell**, which is what Dany asked for on
    // 2026-09-09: _"move the on-hover hint to the right of the cell - so that i
    // can move my cursor down to look at each item one by one uninterrupted"_.
    // Its left edge is the cell's right edge, so the pointer crosses straight
    // from one to the other with nothing in between, and can then walk down the
    // list without ever leaving the card.
    //
    // Proof: `opensSideways` taken off `ExternalRefsCard`'s `HoverCard` — this
    // failed on `the card does not open beside the cell`. Watched 2026-09-09.
    expect(Math.round(cardBox.x), 'the card does not open beside the cell').toBeGreaterThanOrEqual(
      Math.round(cellBox.x + cellBox.width) - 1,
    );
    expect(cardBox.y, 'the card is not aligned with its own row').toBeLessThanOrEqual(
      cellBox.y + 1,
    );
    // **Right first, at the cell's own height, and only then down** — which is
    // both what a hand does and the one path with nothing in between. The card
    // is taller than the cell, so the region *below* the cell and *left* of the
    // card belongs to neither: a single diagonal to the card's vertical middle
    // cuts that corner, and the first version of this test did exactly that and
    // failed on `the card closed on the way over to it`.
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
    await page.mouse.move(cardBox.x + 2, cellBox.y + cellBox.height / 2, { steps: 8 });
    await expect(card, 'the card closed on the way over to it').toBeVisible();
    await page.mouse.move(cardBox.x + 2, cardBox.y + cardBox.height / 2, { steps: 8 });
    await expect(card, 'the card closed while moving down inside it').toBeVisible();
    // And the card's own padding is hit-testable, which is the mechanism rather
    // than the symptom: this is the pixel the cursor fell through before.
    expect(
      await page.evaluate(
        ([x, y]) => {
          const found = document.querySelector('[role="tooltip"]');
          const at = document.elementFromPoint(x, y);
          return found !== null && at !== null && (at === found || found.contains(at));
        },
        [cardBox.x + 2, cardBox.y + cardBox.height / 2],
      ),
      'the card does not take the pointer in its own padding',
    ).toBe(true);

    // **And down the list, one item at a time, which is what the placement is
    // for.** Every step of this stays inside the card. Asserted after **each**
    // item rather than at the end, because a card that survived the first step
    // and died on the third would pass a check made only once.
    const lines = card.locator('[data-refs-card-line]');
    const many = await lines.count();
    expect(many, 'a walk down one line proves nothing').toBeGreaterThan(2);
    for (let at = 0; at < many; at += 1) {
      const line = await lines.nth(at).boundingBox();
      if (line === null) throw new Error(`line ${String(at)} has no box`);
      await page.mouse.move(line.x + 20, line.y + line.height / 2, { steps: 4 });
      await expect(card, `the card closed while walking to item ${String(at + 1)}`).toBeVisible();
    }

    const name = card.locator('a[data-refs-card-name]').first();
    await name.hover();
    await expect(card, 'the card closed on the way to the link').toBeVisible();

    const [opened] = await Promise.all([context.waitForEvent('page'), name.click()]);
    await expect.poll(() => opened.url()).toBe('https://acme.atlassian.net/browse/AB-1');
    await opened.close();
    // The plan is still where it was: a link that opened in a new context did
    // not take the reader off their own page.
    expect(page.url()).toContain('localhost');
  });

  test('the card as a reader sees it', async ({ page }, testInfo) => {
    // Not an assertion — a picture, attached to the run so a person can look at
    // the thing rather than at a list of numbers about it. Dany judges rendered
    // output, and this change exists because five months of green tests never
    // showed anybody that the card was invisible.
    await seed(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByLabel('Links for 010').hover();
    const card = page.getByRole('tooltip', { name: 'Where 010 also exists' });
    await expect(card).toBeVisible();
    await testInfo.attach('links-card.png', {
      body: await page.screenshot({ clip: { x: 0, y: 80, width: 700, height: 260 } }),
      contentType: 'image/png',
    });
  });
});
