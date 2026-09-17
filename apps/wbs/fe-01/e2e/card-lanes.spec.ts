import { expect, type Locator, type Page, test } from '@playwright/test';

import { TAKEOVER_MS } from '../src/components/wbs/cell-card-store';
import { cardIsOnTopAt } from './card-paint';
import { createProject } from './create-project';

/**
 * Every cell card leaves its own column clear, measured by a browser.
 *
 * Dany, 2026-09-09: _"can you please make sure that same scheme works for all
 * cells hover ons — i want to be able to move cursor up and down and see other
 * hover-ons"_. A plan is read down a column: point the Start cell of one row,
 * then the next row's, then the next. Every one of these columns opens a card
 * that hangs **over the rows below**, so the question this file asks is whether
 * the pointer can still reach the trigger under that card — and it is a
 * browser's question three times over. jsdom lays nothing out, performs no hit
 * test, and has no pointer to walk.
 *
 * The answer since `cards-open-diagonally` is one rule for all of them — a card
 * stands past its cell and past its row — and what still differs per column is
 * what a card does with the pointer:
 *
 * - A card nothing can be clicked in is **pointer-transparent**, so even where
 *   it hangs over a row the hit test goes straight through it to the trigger
 *   below. Start, Types, Tags and the folded step columns are these.
 * - A card that takes the pointer — the links card's whole surface, every line
 *   of the dependency card, the notes preview because it scrolls — is reachable
 *   only because it is out of its own column, and swallows whatever it covers.
 *
 * Measured here per column rather than argued once, because the property is a
 * conjunction of a card's placement, its `pointer-events` and the shape of its
 * trigger, and each column combines those differently.
 */

/** The layout this file measures: the four reference columns on screen. */
async function showReferenceColumns(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  for (const label of ['Teams', 'Tags', 'Services', 'Types']) {
    await page.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await page.getByText('Columns', { exact: true }).click();
}

/**
 * Three rows, each carrying something in every column this file walks.
 *
 * **Three and not two**, for the reason every walk in `hover-cards.spec.ts`
 * carries: a lane freed for the first trigger and not the third would pass a
 * check made once. The dependency column needs the walk to start on `020`,
 * since a row's card lists what it waits for and `010` waits for nothing.
 *
 * The reference columns are shown **before** the notes are typed, because
 * showing them is what makes the Name column 192px — the width at which the
 * first cut of `clearsMarkerLane` lost to {@link CARD_MIN_WIDTH_PX} and stood
 * over the lane again.
 */
async function seedPlan(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);

  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (const number of ['010', '020', '030']) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${number}`)).toBeVisible();
  }
  await showReferenceColumns(page);

  for (const number of ['010', '020', '030']) {
    const name = page.getByLabel(`Name of ${number}`);
    await name.fill(
      `Row ${number}\n\nNotes for ${number}: ` +
        'a paragraph long enough that the card takes every pixel its cell allows, '.repeat(5),
    );
    await name.blur();
    const estimate = page.getByLabel(`Dev estimate for ${number}`);
    await estimate.fill('2/3/8');
    await estimate.blur();
    for (const [kind, word] of [
      ['Types', 'Build'],
      ['Tags', 'urgent'],
    ] as const) {
      const box = page.getByRole('combobox', { name: `${kind} for ${number}`, exact: true });
      await box.click();
      await box.fill(word);
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('combobox', { name: `${kind} for ${number}`, exact: true }),
      ).toHaveValue('');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    await page.mouse.move(0, 0);
  }

  // 020 and 030 each wait for 010, so both have a dependency card to open.
  for (const number of ['020', '030']) {
    const depends = page.getByLabel(`Add a dependency to ${number}`);
    await depends.click();
    await depends.fill('010');
    await depends.press('Enter');
    await expect(
      page.getByRole('button', { name: `Stop ${number} waiting for 010` }),
    ).toBeVisible();
    // Twice: the first Escape shuts the offered list, the second leaves the box.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  await page.mouse.move(0, 0);
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
}

async function jsonGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (at) => {
    const response = await fetch(at);
    if (!response.ok) throw new Error(`GET ${at} failed: ${String(response.status)}`);
    return response.json() as Promise<T>;
  }, path);
}

/**
 * Gives every row one Jira link, through be-01's own command route.
 *
 * Through the API and not the cell editor because the Links column is not on
 * screen to be typed into until the plan already has a link — the column is
 * contextual, which is the thing this fixture has to get past.
 */
async function linkEveryRow(page: Page): Promise<void> {
  // The **open** project, off the same key the app selects from. Taking the
  // last of `/api/projects` instead linked the previous test's plan and left
  // this one's Links cells empty, which reads as "the card would not open":
  // one file, two projects, and that list is not in the order they were made.
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id to link');
  const vocabulary = await jsonGet<{ externalSystems: { id: string; name: string }[] }>(
    page,
    '/api/external-systems',
  );
  const jira = vocabulary.externalSystems.find((each) => each.name === 'jira-issue')?.id;
  if (jira === undefined) throw new Error('be-01 seeded no jira-issue system');
  const tree = await jsonGet<{ workItems: { id: string; number: string }[] }>(
    page,
    `/api/projects/${projectId}/work-items`,
  );
  for (const row of tree.workItems) {
    await page.evaluate(
      async ({ at, value }) => {
        const response = await fetch(at, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        });
        if (!response.ok) throw new Error(`POST ${at} failed: ${String(response.status)}`);
      },
      {
        at: `/api/projects/${projectId}/commands`,
        value: {
          commands: [
            {
              kind: 'patchWorkItem',
              workItemId: row.id,
              patch: {
                externalRefs: [
                  {
                    systemId: jira,
                    url: `https://acme.atlassian.net/browse/AB-${row.number}`,
                    name: `AB-${row.number} A linked ticket`,
                  },
                ],
              },
            },
          ],
        },
      },
    );
  }
  await page.reload();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
}

const rowOf = (page: Page, number: string): Locator =>
  page.locator('tbody tr').filter({ has: page.getByLabel(`Name of ${number}`) });

const cellOf = (page: Page, number: string, column: string): Locator =>
  rowOf(page, number).locator(`td[data-column="${column}"]`);

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One column's walk: what to point at, and where the card it opens lives. */
interface Lane {
  /** The column, as the failure messages name it. */
  what: string;
  /** The `<td>` the card is rendered inside — the cell, not the trigger. */
  cellOf: (page: Page, number: string) => Locator;
  /** What the pointer aims at — the cell itself, or a mark inside it. */
  triggerOf: (page: Page, number: string) => Locator;
  /** The two consecutive rows walked, in order. */
  rows: readonly [string, string];
}

/** A column's cell by `data-column`, which is how all but one of these are found. */
const columnCell =
  (column: string) =>
  (page: Page, number: string): Locator =>
    cellOf(page, number, column);

const middleOf = (box: Box): { x: number; y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/**
 * Brings the pointer to a cell **down its own column**, from the header above it.
 *
 * A diagonal from the corner of the window crosses other columns on the way,
 * and since 2026-09-10 that matters: the notes preview opens *beside* its cell
 * and takes the pointer (it scrolls), so a path that clips a `≡` marker on the
 * way leaves a 640px card standing over the column this walk is about, and the
 * cell it lands on never sees the pointer at all. Found here as `Depends on: 020
 * opened no card`.
 */
async function pointDownTheColumn(page: Page, at: { x: number; y: number }): Promise<void> {
  const header = await page.locator('thead tr').first().boundingBox();
  if (header === null) throw new Error('the table has no header to start from');
  await page.mouse.move(at.x, header.y + header.height / 2);
  await page.mouse.move(at.x, at.y, { steps: 6 });
}

const LANES: readonly Lane[] = [
  {
    what: 'Start',
    cellOf: columnCell('start'),
    triggerOf: (page, number) => cellOf(page, number, 'start'),
    rows: ['010', '020'],
  },
  {
    // The Name cell answers from its marker alone, so the lane is the 15px
    // column of `≡` marks at the cells' right edge rather than the cell.
    what: 'the notes preview',
    cellOf: columnCell('name'),
    triggerOf: (page, number) => page.getByLabel(`Notes on ${number}`),
    rows: ['010', '020'],
  },
  {
    what: 'Depends on',
    cellOf: columnCell('depends'),
    triggerOf: (page, number) => cellOf(page, number, 'depends'),
    rows: ['020', '030'],
  },
  {
    what: 'Types',
    cellOf: columnCell('type'),
    triggerOf: (page, number) => cellOf(page, number, 'type'),
    rows: ['010', '020'],
  },
  {
    what: 'Tags',
    cellOf: columnCell('tag'),
    triggerOf: (page, number) => cellOf(page, number, 'tag'),
    rows: ['010', '020'],
  },
  {
    // The folded step column, whose `data-column` is the step's own id —
    // minted when the project was made, so it is reached through the box
    // inside it, the way `hover-cards.spec.ts` reaches the same cell.
    what: 'the folded Dev step',
    cellOf: (page, number) =>
      page.getByLabel(`Dev estimate for ${number}`).locator('xpath=ancestor::td[1]'),
    triggerOf: (page, number) => page.getByLabel(`Dev estimate for ${number}`).locator('..'),
    rows: ['010', '020'],
  },
];

/** The box a locator occupies, refused rather than defaulted when it has none. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box`);
  return box;
}

/**
 * The card open inside one row's cell of a column, read once.
 *
 * Through the cell rather than by the card's name, because two of these cards
 * carry no name at all: the folded step card is an `aria-describedby` target
 * (`folded-step-card.tsx` says why it has no label), and asking "is this row's
 * own card open" of the cell it is rendered in is the same question with no
 * per-column vocabulary.
 */
const cardIn = (lane: Lane, page: Page, number: string): Promise<number> =>
  lane.cellOf(page, number).locator('[role="tooltip"]').count();

test.describe('every cell card leaves its own column clear', () => {
  test.beforeEach(async ({ page }) => {
    await seedPlan(page);
  });

  test('the pointer walks down each column and every row answers for itself', async ({ page }) => {
    test.setTimeout(180_000);
    for (const lane of LANES) {
      const [first, second] = lane.rows;
      await page.mouse.move(0, 0);
      await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

      const from = middleOf(await boxOf(lane.triggerOf(page, first), `${lane.what} ${first}`));
      await pointDownTheColumn(page, from);
      expect(await cardIn(lane, page, first), `${lane.what}: ${first} opened no card`).toBe(1);

      // The precondition, before the claim: a card that stops above the next
      // row's trigger could not cover it whatever its placement and pointer
      // events were, and a walk asserted in that state is R5 #16's own shape.
      const card = await boxOf(
        lane.cellOf(page, first).locator('[role="tooltip"]'),
        `${lane.what}'s open card`,
      );
      const target = await boxOf(lane.triggerOf(page, second), `${lane.what} ${second}`);
      expect(
        card.y + card.height,
        `${lane.what}: the open card stops above ${second}'s own trigger`,
      ).toBeGreaterThan(target.y);

      // **What the reader's aim lands on**, which is the geometry half of the
      // claim: with the card open, the point they would move to in the next row
      // must belong to that row rather than to the card. A pointer-transparent
      // card passes this by hit-testing through to the cell underneath; a card
      // that takes the pointer passes it only by being somewhere else.
      //
      // Proof, twice. `clearsMarkerLane` back to the `left: -24px` + `100%`
      // shape it shipped with this morning: `the notes preview: the open card
      // is over 020's own trigger · Expected: "the row" · Received: "the open
      // card (H1)"`. And `opensSideways` off the dependency card: `Depends on:
      // … Received: "the open card (DIV)"` — one of its lines, every one of
      // which takes the pointer. Both watched in Chromium, 2026-09-09.
      const to = middleOf(target);
      const under = await page.evaluate((point) => {
        const node = document.elementFromPoint(point.x, point.y);
        if (node === null) return 'nothing';
        return node.closest('[role="tooltip"]') === null
          ? 'the row'
          : `the open card (${node.tagName})`;
      }, to);
      expect(under, `${lane.what}: the open card is over ${second}'s own trigger`).toBe('the row');

      // And the end-to-end fact, which the geometry alone does not give: the
      // pointer really walks there and the row really answers. `steps` and not
      // `hover()`, which teleports past every pixel a hand crosses (R5 #23).
      //
      // Watched failing twice while this change was being made, both times on
      // `Depends on: the pointer reached 030 and 030 did not answer · Expected:
      // 1 · Received: 0` — with the dependency cell's `mouseenter` guard
      // holding an enter that landed in the row above's own rectangle, which is
      // where the enter crossing a row boundary always lands. That guard is
      // deleted (`plan-cell-props.ts` says why), so today this assertion is the
      // **guarantee** rather than a guard's proof: the fault that can still
      // break it is a card in the way, and the hit test above is what sees that.
      // It is kept because it is what Dany asked for in his own words.
      await page.mouse.move(to.x, to.y, { steps: 12 });
      // The next row answers after the **takeover**, not at once: with a card
      // open, a trigger takes over only once the pointer has rested on it for
      // {@link TAKEOVER_MS} (`card-takeover-delay`). Read once, past that.
      await page.waitForTimeout(TAKEOVER_MS * 3);
      expect(
        await cardIn(lane, page, second),
        `${lane.what}: the pointer reached ${second} and ${second} did not answer`,
      ).toBe(1);
    }
  });

  test('an informative card stands beside its cell, not over its column', async ({ page }) => {
    // Dany, 2026-09-10: _"make sure that same scheme works for all cells hover
    // ons? even the informative ones? I still want to see what is up and down
    // from it for context; like, just push them to the side (left or right) ...
    // depending on where horizontally it is"_.
    //
    // The four cards that only inform — Start, Types, Tags, a folded step — are
    // `pointer-events: none`, so the walk above already worked: the pointer
    // reaches the next row's trigger straight through them. What it does not
    // do is let the reader **see** that row, which is the thing a plan is read
    // down. So they open beside their cell now, and this is the claim that
    // says so.
    //
    // Asked with {@link cardIsOnTopAt}, because a plain hit test cannot: these
    // cards are transparent, so `elementFromPoint` answers the cell underneath
    // whether the card covers it or not (R5 #27).
    //
    // Proof, twice. `opensSideways` taken off all three components: `Start: the
    // card stands over 020's own cell · Expected: not "the card"`. And the side
    // fixed at `left: '100%'`, which is what it was before the room decided:
    // `Start: the card runs off the right of the frame · Expected: <= 1385 ·
    // Received: 1637`, a card 252px past the edge of the plan. Both watched in
    // Chromium, 2026-09-10.
    for (const lane of LANES.filter((each) => each.what !== 'the notes preview')) {
      const [first, second] = lane.rows;
      await page.mouse.move(0, 0);
      await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

      const from = middleOf(await boxOf(lane.triggerOf(page, first), `${lane.what} ${first}`));
      await pointDownTheColumn(page, from);
      expect(await cardIn(lane, page, first), `${lane.what}: ${first} opened no card`).toBe(1);

      // The cell below in the same column, and the cell above where there is
      // one: both are context the reader keeps.
      const below = middleOf(await boxOf(lane.cellOf(page, second), `${lane.what} ${second}`));
      expect(
        await cardIsOnTopAt(page, below),
        `${lane.what}: the card stands over ${second}'s own cell`,
      ).not.toBe('the card');

      // **And past the row as well as past the cell**, which is the other half
      // of the diagonal. Dany, 2026-09-10: _"all display diagonally? like to
      // make both the on-hover element available for vertical scroll of mouse &
      // the whole row seen for context on all columns of the row"_.
      //
      // Proof: the row offset dropped — `top: 0` instead of the measured
      // `pastTheRow.below`, which is where these cards hung before — and this
      // failed on `Start: the card covers its own row · Expected: >= 174.1875 ·
      // Received: 150`. Watched in Chromium, 2026-09-10.
      const rowBox = await boxOf(rowOf(page, first), `${lane.what}'s row`);
      const open = await boxOf(
        lane.cellOf(page, first).locator('[role="tooltip"]'),
        `${lane.what}'s open card`,
      );
      expect(open.y, `${lane.what}: the card covers its own row`).toBeGreaterThanOrEqual(
        rowBox.y + rowBox.height - 1,
      );

      // And it is inside the frame it opens in, which is what choosing the side
      // by the room is for: the Start column stands within a card's width of
      // the right edge, so its card opens **left**.
      const card = await boxOf(
        lane.cellOf(page, first).locator('[role="tooltip"]'),
        `${lane.what}'s open card`,
      );
      const frame = await boxOf(page.locator('[data-table-frame]'), 'the scrolling frame');
      expect(card.x, `${lane.what}: the card starts left of the frame`).toBeGreaterThanOrEqual(
        frame.x - 1,
      );
      expect(
        card.x + card.width,
        `${lane.what}: the card runs off the right of the frame`,
      ).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  });

  test('every card goes when the pointer moves off its cell', async ({ page }) => {
    // Dany, 2026-09-10: _"same goes for other cells - make sure that it goes
    // away at the right time"_. A card held for the length of a reach must
    // still be gone the moment the reader has plainly moved on, or the plan is
    // read through somebody else's card.
    //
    // Every lane, because the hold lives in the store and the cancel is the
    // card's own: a column whose card forgot to report its arrivals would keep
    // the last one up, and a column that never held would lose it under a hand.
    //
    // Proof: `holdHovered`'s timer emptied — the hold started and nothing
    // cleared when it ran out — and this failed on `the notes preview: the card
    // outstayed the pointer · expect(locator).toHaveCount(0)`. Watched in
    // Chromium, 2026-09-10.
    for (const lane of LANES) {
      const [first] = lane.rows;
      await page.mouse.move(0, 0);
      await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

      const from = middleOf(await boxOf(lane.triggerOf(page, first), `${lane.what} ${first}`));
      await pointDownTheColumn(page, from);
      expect(await cardIn(lane, page, first), `${lane.what}: ${first} opened no card`).toBe(1);

      // The top-left corner of the window: not the cell, not the card, and not
      // another cardable cell either — so nothing but the dismissal can close
      // it.
      await page.mouse.move(4, 4, { steps: 10 });
      await expect(
        page.locator('[role="tooltip"]'),
        `${lane.what}: the card outstayed the pointer`,
      ).toHaveCount(0);
    }
  });

  test('the links card leaves its own column clear too', async ({ page }) => {
    // The Links column is **contextual**: it is offered only for a plan that has
    // links (`contextual-links-default`), so this walk needs a fixture the other
    // six lanes do not — hence its own test rather than a seventh lane.
    await linkEveryRow(page);
    // Through the Columns menu rather than the `Reset layout` gesture the
    // external-refs fixture uses: that gesture is offered **once** per reader,
    // and this file's own seed has already taken a layout decision by showing
    // the four reference columns, so the button is not always there to click.
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Links', exact: true }).check();
    await page.getByText('Columns', { exact: true }).click();
    await expect(page.getByLabel('Links for 010')).toBeVisible();

    const lane: Lane = {
      what: 'Links',
      cellOf: columnCell('refs'),
      triggerOf: (at, number) => at.getByLabel(`Links for ${number}`),
      rows: ['010', '020'],
    };
    // The four reference columns are still on screen, so the Links column can
    // stand right of the fold — a pointer moved to a point outside the window
    // hovers nothing at all.
    // Right of the fold with the reference columns on screen, so it is scrolled
    // to before it is pointed at: a pointer moved to a point outside the window
    // hovers nothing at all.
    await lane.triggerOf(page, '010').scrollIntoViewIfNeeded();
    const from = middleOf(await boxOf(lane.triggerOf(page, '010'), 'the Links cell of 010'));
    await page.mouse.move(from.x, from.y, { steps: 6 });
    expect(await cardIn(lane, page, '010'), '010 opened no links card').toBe(1);

    const card = await boxOf(
      lane.cellOf(page, '010').locator('[role="tooltip"]'),
      'the links card',
    );
    const target = await boxOf(lane.triggerOf(page, '020'), 'the Links cell of 020');
    expect(
      card.y + card.height,
      'the links card stops above the next row’s own cell',
    ).toBeGreaterThan(target.y);

    const to = middleOf(target);
    const under = await page.evaluate((point) => {
      const node = document.elementFromPoint(point.x, point.y);
      if (node === null) return 'nothing';
      return node.closest('[role="tooltip"]') === null
        ? 'the row'
        : `the open card (${node.tagName})`;
    }, to);
    expect(under, 'the links card is over the next row’s own cell').toBe('the row');

    await page.mouse.move(to.x, to.y, { steps: 12 });
    // Past the takeover, as above: a rested pointer gets the next row's card
    // {@link TAKEOVER_MS} after landing.
    await page.waitForTimeout(TAKEOVER_MS * 3);
    expect(await cardIn(lane, page, '020'), '020 did not answer with its own links').toBe(1);
  });
});
