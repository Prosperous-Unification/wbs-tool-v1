import { expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

test.use({ viewport: { width: 1280, height: 900 } });

interface Entry {
  id: string;
  name: string;
}
interface Seed {
  teams: Entry[];
  tags: Entry[];
  services: Entry[];
  /**
   * The plan and the child row, for a test that needs to arrange a **resting**
   * cell rather than drive one.
   *
   * A cell is arranged through the UI wherever the gesture is part of the
   * claim. It is arranged through the API where it is not: an open picker is a
   * panel over the row below, so driving a parent's cell and then a child's in
   * one pass measures a page with a popover standing on it.
   */
  projectId: string;
  childId: string;
}

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

/** One directory batch, answering the entry each command created (by index). */
async function directoryCommands<T>(page: Page, list: Record<string, unknown>[]): Promise<T[]> {
  const answer = await jsonPost<{ results: { entity?: T }[] }>(page, '/api/directory/commands', {
    commands: list,
  });
  return answer.results.map((each) => {
    if (each.entity === undefined) throw new Error('a directory create answered no entry');
    return each.entity;
  });
}

async function seed(page: Page): Promise<Seed> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page);

  await expect.poll(() => page.evaluate(() => localStorage.getItem('wbs.project'))).not.toBeNull();
  const projectId = await page.evaluate(() => localStorage.getItem('wbs.project'));
  if (projectId === null) throw new Error('no project id after creating the plan');
  // Four rows in one batch, each placed after the one before it by ref.
  await commands(
    page,
    projectId,
    ['010', '020', '030', '040'].map((number, at) => ({
      kind: 'createWorkItem',
      ref: number,
      parentId: null,
      ...(at === 0 ? { afterId: null } : { afterRef: ['010', '020', '030', '040'][at - 1] }),
      name: `Reference ${number}`,
    })),
  );

  const make = (kind: 'createTeam' | 'createTag' | 'createService', names: string[]) =>
    directoryCommands<Entry>(
      page,
      names.map((name) => ({ kind, name })),
    );
  const teams = await make('createTeam', ['Platform', 'Release', 'Support']);
  const tags = await make('createTag', ['Ready', 'Risk', 'Review']);
  const services = await make('createService', ['Billing', 'Identity', 'Search']);

  const tree = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/${id}/work-items`);
    return response.json() as Promise<{ workItems: { id: string; number: string }[] }>;
  }, projectId);
  const byNumber = new Map(tree.workItems.map((row) => [row.number, row.id]));
  const id010 = byNumber.get('010');
  const id020 = byNumber.get('020');
  const id030 = byNumber.get('030');
  const id040 = byNumber.get('040');
  if (id010 === undefined || id020 === undefined || id030 === undefined || id040 === undefined)
    throw new Error('the four reference rows were not created');

  const [childId] = await commands(page, projectId, [
    { kind: 'createWorkItem', parentId: id010, afterId: null, name: 'Inherited reference child' },
    {
      kind: 'patchWorkItem',
      workItemId: id010,
      patch: {
        teamIds: teams.slice(0, 2).map(({ id }) => id),
        tagIds: tags.slice(0, 2).map(({ id }) => id),
        serviceIds: services.slice(0, 2).map(({ id }) => id),
      },
    },
    { kind: 'addDependency', workItemId: id040, predecessorId: id010 },
    { kind: 'addDependency', workItemId: id040, predecessorId: id020 },
  ]);
  if (childId === undefined) throw new Error('the inherited reference child was not created');
  await page.reload();
  return { teams, tags, services, projectId, childId };
}

/**
 * Pick an existing entry in one reference cell, and **leave the cell**.
 *
 * The blur is not tidiness. Since `reference-cell-popover` a focused strip
 * leaves the flow and opens as a panel `calc(100% + 4px)` wide that hangs over
 * the rows below — deliberately, those being the pixels a popover is allowed to
 * take — so a `choose` that returned with the focus still in the box leaves an
 * opaque panel standing over the next row's cells.
 *
 * It is **not sufficient** on its own, and that is worth knowing: with the blur
 * in place, a following click aimed at the row below still timed out at 60s on
 * `<span data-reference-chips>… from <tr …> subtree intercepts pointer events`.
 * Whatever else is standing there, this file does not drive two cells of
 * neighbouring rows in one pass; it arranges the second through the API and
 * reloads. Watched 2026-08-30.
 */
async function choose(page: Page, label: string, name: string): Promise<void> {
  const box = page.getByRole('combobox', { name: label, exact: true });
  await box.click();
  await box.fill(name);
  await page.getByRole('option', { name, exact: true }).click();
  await box.blur();
}

async function chooseTheme(page: Page, answer: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('button', { name: 'local-dev' }).click();
  await page.getByRole('menuitemradio', { name: answer }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => !['finished', 'idle'].includes(animation.playState)).length,
      ),
    )
    .toBe(0);
}

async function showReferenceColumns(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  for (const label of ['Teams', 'Tags', 'Services', 'Depends on']) {
    await page.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await page.getByText('Columns', { exact: true }).click();
}

/**
 * Whether the point at the middle of this element belongs to it — the browser's
 * own answer, which is the only one that knows about clipping, masks and
 * whatever is painted over it. jsdom lays nothing out and cannot be asked.
 */
/** The `<td>` a reference cell's box stands in, found by the box's own name. */
function cellOf(page: Page, label: string): Locator {
  return page.getByRole('combobox', { name: label, exact: true }).locator('xpath=ancestor::td[1]');
}

async function hitsItself(target: Locator): Promise<boolean> {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && box.height > 0 && hit !== null && node.contains(hit);
  });
}

/**
 * How many nodes of `within` a reader can see saying `needle`: an element's own
 * drawn text, or a box's placeholder or value.
 *
 * Not accessible names, and not `title`: the duplicate this counts is a
 * **second visible node**, which an accessible-name count reads as one.
 */
async function drawnSayings(within: Locator, needle: string): Promise<number> {
  return within.evaluate(
    (root, said) =>
      [...root.querySelectorAll('*')].filter((node) => {
        if (node instanceof HTMLInputElement)
          return node.placeholder.includes(said) || node.value.includes(said);
        return [...node.childNodes]
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent ?? '')
          .join('')
          .includes(said);
      }).length,
    needle,
  );
}

/**
 * Every chip of a strip, reachable and painted, **while the cell is being
 * edited** — which is where a crowded 120px cell puts them.
 *
 * At rest the strip is one clipped line (4b.1): a third chip in a 120px column
 * is past the edge, and that is the trade the fade at the end of the line
 * announces. Entering the box wraps them all into reach, and that is the state
 * a reader removes a member from, so it is the state this measures.
 */
async function assertReachablePaint(page: Page, roots: Locator[]): Promise<void> {
  for (const root of roots) {
    const chips = root.locator('[data-reference-chip]');
    await expect(chips).toHaveCount(3);
    const box = root.getByRole('combobox').first();
    await box.focus();
    for (let index = 0; index < 3; index += 1) {
      const chip = chips.nth(index);
      await expect(chip).toBeVisible();
      expect(
        await hitsItself(chip),
        `reference chip ${String(index + 1)} is clipped or covered`,
      ).toBe(true);
    }
    await box.blur();
  }
  expect(
    await page.evaluate(() => {
      const unnamed = new Set(['rgb(239, 239, 239)', 'rgb(107, 107, 107)']);
      return [...document.querySelectorAll('[data-reference-set] button')]
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) => unnamed.has(getComputedStyle(node).backgroundColor))
        .map((node) => node.getAttribute('aria-label') ?? node.textContent);
    }),
  ).toEqual([]);
}

test('round-trips every desktop reference set with three reachable values in both palettes', async ({
  page,
}) => {
  const seeded = await seed(page);
  await showReferenceColumns(page);
  await choose(page, 'Service or team for 010', seeded.teams[2].name);
  await choose(page, 'Tags for 010', seeded.tags[2].name);
  await choose(page, 'Services for 010', seeded.services[2].name);
  const depends = page.getByLabel('Add a dependency to 040');
  await depends.click();
  await depends.fill('030');
  await depends.press('Enter');
  await expect(page.getByRole('button', { name: /^Stop 040 waiting for / })).toHaveCount(3);

  await page.reload();
  const roots = (['team', 'tag', 'service'] as const).map((kind) =>
    page
      .locator(`[data-reference-set="${kind}"]`)
      .filter({
        has: page.locator('[data-reference-chip]'),
      })
      .first(),
  );
  // The desktop's whole reading of inheritance: one drawing of it per cell, and
  // no second line under it. `Inherited: …` is the phone sheet's line, and
  // drawing both is what stood the Tags column three lines tall (4b.3).
  await expect(page.locator('[data-reference-inherited]')).toHaveCount(0);
  // The **team** cell still says it in the box's placeholder ink, because that
  // dimension overrides and the box is empty exactly when there is something to
  // say. The tag cell draws chips instead (ADR 0008) — a row that states a tag
  // of its own carries its ancestor's too, and there is no empty box left.
  await expect(
    page.getByRole('combobox', { name: 'Service or team for 010.1', exact: true }),
  ).toHaveAttribute('placeholder', /^↳ /);
  await expect(page.getByRole('combobox', { name: 'Tags for 010.1', exact: true })).toHaveAttribute(
    'placeholder',
    'add',
  );
  await expect(
    cellOf(page, 'Tags for 010.1').locator('[data-reference-inherited-chip]'),
  ).toHaveCount(3);
  for (const palette of ['Light', 'Dark'] as const) {
    await chooseTheme(page, palette);
    await assertReachablePaint(page, roots);
    await page.getByLabel('Add a dependency to 040').locator('xpath=ancestor::td').hover();
    await expect(
      page
        .getByRole('tooltip', { name: 'What 040 waits for' })
        .locator('[data-depends-card-target]'),
    ).toHaveCount(3);
    await page.mouse.move(0, 0);
  }

  // Opened first, and that is the contract rather than a workaround. A rest
  // line is one clipped line: a chip past the column's edge is drawn as a
  // sliver and its `✕` may be under the search box beside it, which — being
  // later in the DOM — takes the press. Reaching it is what opening the cell
  // is *for*, and the panel wraps every chip into reach.
  //
  // Written without the focus, this timed out at 60s on `<input …
  // aria-label="Tags for 010"> from <span data-reference-search> subtree
  // intercepts pointer events` — the whole-gate run, 2026-08-29, and the fault
  // that put `overflow: hidden` on the chip group.
  const removeFrom = async (label: string, button: string): Promise<void> => {
    await page.getByRole('combobox', { name: label, exact: true }).focus();
    await page.getByRole('button', { name: button }).click();
    await page.getByRole('combobox', { name: label, exact: true }).blur();
  };
  await removeFrom('Service or team for 010', `Remove ${seeded.teams[0].name} team`);
  await removeFrom('Tags for 010', `Remove ${seeded.tags[0].name} from 010`);
  await removeFrom('Services for 010', `Remove ${seeded.services[0].name} from 010`);
  await page.getByRole('button', { name: 'Stop 040 waiting for 010' }).click();
  await page.reload();

  for (const [kind, entries] of [
    ['team', seeded.teams],
    ['tag', seeded.tags],
    ['service', seeded.services],
  ] as const) {
    const root = page
      .locator(`[data-reference-set="${kind}"]`)
      .filter({ has: page.locator('[data-reference-chip]') })
      .first();
    await expect(root.locator(`[data-reference-chip="${entries[0].id}"]`)).toHaveCount(0);
    await expect(root.locator(`[data-reference-chip="${entries[1].id}"]`)).toBeVisible();
    await expect(root.locator(`[data-reference-chip="${entries[2].id}"]`)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /^Stop 040 waiting for / })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Stop 040 waiting for 010' })).toHaveCount(0);
});

/**
 * 4b's own proof, and it has to be a browser's: every claim below is a
 * measurement of laid-out boxes — how tall a row stands, what a point in it
 * hits, how much width a floor took from the chips beside it. jsdom lays
 * nothing out, so its green says nothing about any of them (R5 #14–16).
 *
 * Reported by Dany with a screenshot on 2026-08-29: a Tags cell three lines
 * tall, its inherited set drawn twice. The **resting** row height is the
 * claim; a crowded cell is allowed to grow while it is being edited, and each
 * assertion below says which of the two states it stands in.
 */
test('rests every reference row on one line and opens a crowded cell to reach every chip', async ({
  page,
}) => {
  const seeded = await seed(page);
  await showReferenceColumns(page);
  // 010 already states two teams, two tags and two services; a third tag is
  // the reported cell exactly. 020 takes one team, which is the only set size
  // a resting value could repeat. 030 states nothing and is the baseline.
  await choose(page, 'Tags for 010', seeded.tags[2].name);
  await choose(page, 'Service or team for 020', seeded.teams[0].name);
  // 010.1 states the third tag itself and carries the other two from 010 —
  // ADR 0008's own row, and the shape the 2026-08-29 report is about. It is the
  // most crowded Tags cell on the page: one own chip with a ✕, two inherited
  // ones without.
  //
  // **Written through the API, not the picker**, and that is a finding rather
  // than a shortcut. This test measures rows at rest, and every cell it opens
  // on the way there leaves an opaque panel `calc(100% + 4px)` wide standing
  // over the row below (`reference-cell-popover`). 010.1 is the row below 010,
  // whose Tags cell this test opens two lines up, so driving 010.1's cell in the
  // same pass aims a click at a page with a popover on it: Chromium timed out at
  // 60s on `<span data-reference-chips>… from <tr …> subtree intercepts pointer
  // events`, twice — once clicking the box and once clicking the `+` — and a
  // `blur()` between them did not clear it. Watched 2026-08-30.
  //
  // The gesture is not what this test is about; the resting geometry is. Both
  // are covered — the picker on a crowded cell is the paragraph below, in the
  // state the cell is actually removed from.
  await commands(page, seeded.projectId, [
    {
      kind: 'patchWorkItem',
      workItemId: seeded.childId,
      patch: { tagIds: [seeded.tags[2].id] },
    },
  ]);
  await page.reload();

  const heightOf = async (label: string, what: string): Promise<number> => {
    const box = await cellOf(page, label).boundingBox();
    if (box === null) throw new Error(`${what} has no painted box`);
    return box.height;
  };

  const bare = await heightOf('Tags for 030', 'the row that states nothing');
  // Every row, not only the reported one. The fault this failed on was in the
  // Services cell's wrapper, so a check that measured the Tags cell alone
  // would have watched the wrong column: 010 carries chips in three
  // dimensions, and 010.1 carries the inherited reading of all three plus the
  // non-owner mark that stood beside them.
  expect(
    await heightOf('Tags for 010', 'the crowded row'),
    'three tags stand the row taller than a row with none',
  ).toBeLessThanOrEqual(bare + 1);
  expect(
    await heightOf('Tags for 010.1', 'the inheriting row'),
    'an inherited set stands the row taller than a row with none',
  ).toBeLessThanOrEqual(bare + 1);
  /*
    The accumulating cell, on the one line the two heights above have just
    measured: its own chip first, the two it carries after it.

    **A `scrollWidth > clientWidth` assertion stood here and was deleted**, and
    the deletion is the point. It was written on the reasoning that a height
    check might be vacuous — the `<td>` clips with `overflow: clip` since
    `reference-cell-popover`, so a wrapped strip could be cut rather than push
    its row taller — and that a wrapped line's missing horizontal overflow would
    catch what the height missed.

    Injecting the fault it was written for said otherwise. `flexWrap` pinned to
    `'wrap'` on the resting strip failed on `three tags stand the row taller
    than a row with none`, `Expected: <= 27.1875 / Received: 68.1875` — the
    height check three lines up, doing exactly its job, on the row that carries
    three chips of its own. Moved above the heights the new assertion still
    never ran, because that one fires first and it is not mine to reorder. A
    guard whose removal cannot be observed does not ship (R5, `P phases-ui`,
    `T1 column-widths-drag`). The heights are the oracle; this block asserts
    what is drawn, not how tall it is.
  */
  const carrying = cellOf(page, 'Tags for 010.1');
  await expect(carrying.locator('[data-reference-chip]')).toHaveCount(1);
  await expect(carrying.locator('[data-reference-inherited-chip]')).toHaveCount(2);
  // A tag comes off where it was written, which is ADR 0008's own consequence:
  // the only ✕ in this cell belongs to the tag this row states.
  //
  // Proof: a `Remove` button added inside the inherited chip — the shape a
  // reader would reach for on seeing a chip without one — and this failed in
  // Chromium on `Expected: 1 / Received: 3`. Watched 2026-08-30. jsdom watched
  // the same fault at `reference-set-field.test.tsx`; the browser is what says
  // the extra ✕ is also **reachable**, which is what makes it a bug.
  await expect(carrying.getByRole('button', { name: /^Remove / })).toHaveCount(1);
  await expect(
    carrying.getByRole('button', { name: `Remove ${seeded.tags[2].name} from 010.1` }),
  ).toHaveCount(1);
  expect(
    await hitsItself(carrying.locator('[data-reference-chip]').first()),
    'the row’s own chip is clipped or covered by what it carries',
  ).toBe(true);
  // **The way into a cell that carries more than it can draw.** Three chips fill
  // this 120px line and the search box behind them has no width left to click,
  // so the `+` is the only gesture that still opens the picker. It is
  // `shrink-0` and first in the strip for this reason, and this is where that
  // stops being a claim: without it, a row under a tagged ancestor could be
  // tagged from nowhere at all.
  expect(
    await hitsItself(carrying.locator('[data-reference-add]')),
    'the add button is clipped or covered on a cell full of inherited chips',
  ).toBe(true);
  expect(
    await heightOf('Service or team for 020', 'the one-member row'),
    'one own member stands the row taller than a row with none',
  ).toBeLessThanOrEqual(bare + 1);

  const crowded = cellOf(page, 'Tags for 010');
  const crowdedCell = await crowded.boundingBox();
  const strip = crowded.locator('[data-reference-strip]');
  const stripBox = await strip.boundingBox();
  if (crowdedCell === null || stripBox === null) throw new Error('the crowded cell is not painted');
  expect(stripBox.width, 'the rest line spills out of its column').toBeLessThanOrEqual(
    crowdedCell.width + 1,
  );

  // The two things a clipped rest line must never clip: the add affordance on
  // the leading edge, and the first chip beside it.
  expect(
    await hitsItself(strip.locator('[data-reference-add]')),
    'the add button is clipped or covered at rest',
  ).toBe(true);
  expect(
    await hitsItself(strip.locator('[data-reference-chip]').first()),
    'the first chip is clipped or covered at rest',
  ).toBe(true);

  // The search box takes what the chips leave, and at rest that is nearly
  // nothing: a 72px floor in a 120px column is where the third line came from.
  const searchBox = await strip.locator('[data-reference-search]').boundingBox();
  if (searchBox === null) throw new Error('the search holder was not painted');
  expect(searchBox.width, 'the search box still claims a width floor at rest').toBeLessThan(72);

  // The rest line really is clipped — three chips do not fit in 120px — and
  // the clip is what keeps the overflowing chip out of the column beside it.
  // A bounding box cannot say this: `getBoundingClientRect` reports the
  // unclipped layout box, so the last chip's rectangle hangs over the next
  // column whether or not anything is painted there. Hit-testing is the only
  // thing that knows.
  expect(
    await strip.evaluate((node) => node.scrollWidth > node.clientWidth),
    'three chips fit the rest line, so this row proves no clipping at all',
  ).toBe(true);
  expect(
    await hitsItself(strip.locator('[data-reference-chip]').last()),
    'the clipped chip is still hit-testable, so the rest line does not clip',
  ).toBe(false);
  expect(
    await strip.evaluate((node) => getComputedStyle(node).maskImage),
    'the clipped rest line wears no truncation cue',
  ).not.toBe('none');

  // Entering the cell is what brings a clipped member back into reach — the
  // state a member is removed from, and therefore the state it must be in.
  const box = page.getByRole('combobox', { name: 'Tags for 010', exact: true });
  await box.focus();
  const chips = strip.locator('[data-reference-chip]');
  await expect(chips).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    expect(
      await hitsItself(chips.nth(index)),
      `tag chip ${String(index + 1)} is out of reach while the cell is edited`,
    ).toBe(true);
  }
  // **While it is open**, which is where the fault lived. The check below
  // measures the row after the blur and passed all through the 2026-08-29
  // report: the wrap was in the flow, so the row grew for exactly as long as
  // somebody was reading the cell and settled back the moment they left.
  // Assert in the window the fault lives in (`AGENTS.md`, `D directory-page`).
  //
  // Proof: the panel's `position: 'absolute'` removed, this failed on
  // `Expected: <= 28.171875 / Received: 44.171875`. Watched, 2026-08-29.
  expect(
    await heightOf('Tags for 010', 'the crowded row while it is open'),
    'the open cell stands its row taller than a row with none',
  ).toBeLessThanOrEqual(bare + 1);

  // The displacement, which is the other half of the report and a different
  // fault: the Tags column was not in `POPOVER_COLUMNS`, so its `<td>` kept
  // `CELL`'s clip — and a clipped box that is `overflow: hidden` is a scroll
  // container, which Chromium scrolled to reveal the list opening inside it.
  // The cell then drew its own strip above its own row and took the `+` off
  // screen with it.
  //
  // Both guards are asserted, because either alone lets the other rot: the
  // exemption stops this cell scrolling, and `overflow: clip` stops any cell
  // scrolling ever. Proof: `'tag'` removed from `POPOVER_COLUMNS`, the strip
  // assertion failed on the strip standing above its row; with `CELL` also put
  // back to `hidden`, the scroll assertion failed on `Expected: 0 / Received:
  // 22`. Watched in Chromium, 2026-08-29.
  expect(
    await crowded.evaluate((cell) => cell.scrollTop),
    'the opened cell has been scrolled, so its contents left its row',
  ).toBe(0);
  const openRow = await crowded.boundingBox();
  const openStrip = await strip.boundingBox();
  if (openRow === null || openStrip === null) throw new Error('the open cell is not painted');
  expect(openStrip.y, 'the open strip is drawn above the row it belongs to').toBeGreaterThanOrEqual(
    openRow.y - 2,
  );

  // And the list a cell opens is whole rather than cut to the cell's edge.
  //
  // Not this cell: 010 already carries every seeded tag, so its picker has
  // nothing left to offer and opens no list at all — which is the honest
  // answer for a directory with nothing in it, and would have made an
  // assertion here pass on an empty page. 030 states no tag and is offered all
  // three. (Watched: written against 010, it failed on `Expected: 1 /
  // Received: 0`, an assertion about an open list with no list open.)
  const empty = page.getByRole('combobox', { name: 'Tags for 030', exact: true });
  await empty.focus();
  const list = page.locator('[data-picker-list]');
  await expect(list).toHaveCount(1);
  const listBox = await list.boundingBox();
  const emptyCell = await cellOf(page, 'Tags for 030').boundingBox();
  if (listBox === null || emptyCell === null) throw new Error('the open list is not painted');
  // Three options at 22px. Cut to the sliver of Dany's screenshot — the cell
  // scrolled under an unexempted clip — this is a few pixels tall.
  expect(listBox.height, 'the open list is cut off at the cell edge').toBeGreaterThan(50);
  expect(
    await hitsItself(list.locator('[role="option"]').first()),
    'the first line of the open list cannot be clicked',
  ).toBe(true);
  // The cell has not been scrolled to reveal it, which is the fault itself.
  expect(
    await cellOf(page, 'Tags for 030').evaluate((cell) => cell.scrollTop),
    'the opened cell has been scrolled, so its contents left its row',
  ).toBe(0);
  await empty.blur();

  await box.blur();
  expect(
    await heightOf('Tags for 010', 'the crowded row after editing'),
    'the row keeps the height it took while it was being edited',
  ).toBeLessThanOrEqual(bare + 1);

  // The anchor's line and the strip's are the same line. `REFERENCE_SET_LINE_HEIGHT`
  // is a measurement of what Chromium lays this strip out at, and a constant
  // that drifted from the real height would clip the rest line by the
  // difference — silently, because every style assertion about it is written
  // against the constant itself. This is the one check that reads the browser.
  const restingStrip = await strip.boundingBox();
  const floor = await crowded
    .locator('[data-reference-anchor]')
    .evaluate((node) => parseFloat(getComputedStyle(node).minHeight));
  if (restingStrip === null) throw new Error('the rested cell is not painted');
  // Within a pixel of it rather than equal to it: the strip rests at
  // 24.1875px — Chromium's own layout of a 14px input with this table's border
  // and padding — and a constant written as a fraction would be one nobody can
  // read. What this catches is drift, which is how the number goes wrong: a
  // floor of 12 or of 40 fails here. Watched at `Expected: 24.1875 / Received:
  // 24` when the anchor pinned `height` instead of a floor, which clipped the
  // rest line by the fraction.
  expect(
    Math.abs(floor - restingStrip.height),
    'the line the anchor keeps is not the line the strip stands on',
  ).toBeLessThanOrEqual(1);

  // Said once, per surface. The desktop's reading is the placeholder's `↳`.
  expect(
    await drawnSayings(cellOf(page, 'Tags for 010.1'), seeded.tags[0].name),
    'the inherited set is drawn more than once',
  ).toBe(1);
  expect(
    await drawnSayings(cellOf(page, 'Service or team for 020'), seeded.teams[0].name),
    'the sole own member is drawn more than once',
  ).toBe(1);

  // A ✕ pressed on the resting line removes its member — the gesture a reader
  // makes, and the one that did nothing at all before the press was stopped
  // from taking the focus: the focus wraps the strip, the wrap moved this
  // button between `mousedown` and `mouseup`, and the browser fired no click.
  const first = await chips.first().getAttribute('data-reference-chip');
  if (first === null) throw new Error('the first chip carries no id');
  await crowded
    .getByRole('button', { name: /^Remove / })
    .first()
    .click();
  await expect(
    crowded.locator(`[data-reference-chip="${first}"]`),
    'the chip a click removed at rest is still there',
  ).toHaveCount(0);
  await page.reload();
  await expect(
    cellOf(page, 'Tags for 010').locator(`[data-reference-chip="${first}"]`),
    'the removal did not survive a reload',
  ).toHaveCount(0);
});

test.describe('390x844 reference sheets', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('round-trips three reachable values, inherited context, and light/dark paint', async ({
    page,
  }) => {
    const seeded = await seed(page);
    const parent = page.getByRole('article', { name: 'Work item 010', exact: true });
    const fields = [
      {
        kind: 'team',
        label: 'Service or team for 010',
        trigger: '[data-card-team-field]',
        entries: seeded.teams,
      },
      {
        kind: 'tag',
        label: 'Tags for 010',
        trigger: '[data-card-tags-field]',
        entries: seeded.tags,
      },
      {
        kind: 'service',
        label: 'Services for 010',
        trigger: '[data-card-service-field]',
        entries: seeded.services,
      },
    ] as const;

    const openSheet = async (field: (typeof fields)[number], owner = parent) => {
      await owner.locator(field.trigger).click();
      const dialog = page.getByRole('dialog', { name: `Edit ${field.label}` });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const closeSheet = async (field: (typeof fields)[number], dialog: Locator) => {
      await dialog.getByRole('button', { name: `Close ${field.label}` }).click();
      await expect(dialog).toBeHidden();
    };

    for (const field of fields) {
      const dialog = await openSheet(field);
      const box = dialog.getByRole('combobox', { name: field.label, exact: true });
      await box.fill(field.entries[2].name);
      await dialog.getByRole('option', { name: field.entries[2].name, exact: true }).click();
      await expect(dialog).toBeHidden();
    }

    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    let dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await expect(dependsDialog).toBeVisible();
    await dependsDialog.getByLabel('Add a dependency to 040').fill('030');
    await dependsDialog.locator('[data-card-depends-option="030"]').click();
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(3);
    await page.keyboard.press('Escape');

    await page.reload();

    for (const palette of ['Light', 'Dark'] as const) {
      await chooseTheme(page, palette);
      for (const field of fields) {
        const dialog = await openSheet(field);
        const root = dialog.locator(`[data-reference-set="${field.kind}"]`);
        await assertReachablePaint(page, [root]);
        const sheet = await dialog.boundingBox();
        expect(sheet, `${field.kind} sheet has no painted box`).not.toBeNull();
        expect(sheet!.x, `${field.kind} sheet clips left`).toBeGreaterThanOrEqual(0);
        expect(sheet!.x + sheet!.width, `${field.kind} sheet clips right`).toBeLessThanOrEqual(390);
        expect(sheet!.y + sheet!.height, `${field.kind} sheet clips below`).toBeLessThanOrEqual(
          844,
        );
        await closeSheet(field, dialog);
      }

      await page.getByRole('button', { name: 'Depends on for 040' }).click();
      dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
      await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(3);
      for (const row of await dependsDialog.locator('[data-card-wait]').all()) {
        await expect(row).toBeVisible();
        await expect(row).toBeInViewport();
      }
      expect(
        await dependsDialog.evaluate((dialog) =>
          [...dialog.querySelectorAll('button')]
            .filter((button) => button.getClientRects().length > 0)
            .filter((button) => getComputedStyle(button).backgroundColor === 'rgb(239, 239, 239)')
            .map((button) => button.getAttribute('aria-label') ?? button.textContent),
        ),
        'the dependency sheet exposes a native grey button face',
      ).toEqual([]);
      await page.keyboard.press('Escape');
    }

    const inherited = page.locator('article[data-card]').filter({
      has: page.locator('[data-inherited]'),
    });
    await expect(inherited).toHaveCount(1);
    for (const field of fields) {
      const dialog = await openSheet(field, inherited);
      if (field.kind === 'tag') {
        // The accumulating dimension says it as chips, on the sheet as in the
        // cell: `inheritedLabel` cannot describe a row that states one tag and
        // carries two, so the tag adapter passes `inheritedEntries` and the
        // `Inherited:` line is not drawn at all (ADR 0008).
        //
        // Watched failing on the way in: with the tag sheet still handed
        // `inheritedLabel`, this loop asserted the line for all three fields and
        // Chromium failed on `expect(locator).toContainText(expected) failed …
        // element(s) not found` for `Edit Tags for 010`. 2026-08-30.
        await expect(dialog.locator('[data-reference-inherited]')).toHaveCount(0);
        // Three: 010 states all three seeded tags by now, and 010.1 states
        // none of its own, so it carries every one of them.
        const chips = dialog.locator('[data-reference-inherited-chip]');
        await expect(chips).toHaveCount(3);
        await expect(chips.first()).toContainText('↳ ');
        await expect(chips.first()).toHaveAttribute('data-fact', /inherited from 010 /);
      } else {
        await expect(dialog.locator('[data-reference-inherited]')).toContainText('from 010');
      }
      await closeSheet(field, dialog);
    }

    for (const field of fields) {
      const dialog = await openSheet(field);
      await dialog
        .getByRole('button', { name: `Remove ${field.entries[0].name} from 010` })
        .click();
      await expect(dialog.locator(`[data-reference-chip="${field.entries[0].id}"]`)).toHaveCount(0);
      await closeSheet(field, dialog);
    }
    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await dependsDialog.getByRole('button', { name: 'Stop 040 waiting for 010' }).click();
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await page.reload();

    for (const field of fields) {
      const dialog = await openSheet(field);
      const root = dialog.locator(`[data-reference-set="${field.kind}"]`);
      await expect(root.locator(`[data-reference-chip="${field.entries[0].id}"]`)).toHaveCount(0);
      await expect(root.locator(`[data-reference-chip="${field.entries[1].id}"]`)).toBeVisible();
      await expect(root.locator(`[data-reference-chip="${field.entries[2].id}"]`)).toBeVisible();
      await closeSheet(field, dialog);
    }
    await page.getByRole('button', { name: 'Depends on for 040' }).click();
    dependsDialog = page.getByRole('dialog', { name: 'Depends on for 040' });
    await expect(dependsDialog.locator('[data-card-wait]')).toHaveCount(2);
    await expect(dependsDialog.locator('[data-card-wait="010"]')).toHaveCount(0);
  });
});

/**
 * Adding a second value without leaving the cell — Dany, 2026-08-31: _"after
 * adding `tag1` the UI invites another tag, but clicking the small add field
 * shows no dropdown of existing tags"_.
 *
 * A browser and not jsdom, and the reason is the whole shape of the fault: the
 * list opens from the box's `focus`, a successful take closes it **with the box
 * still focused**, and clicking a node that already holds the focus fires no
 * focus event. jsdom's `fireEvent.click` dispatches a click with no focus
 * bookkeeping at all, so a jsdom case can be written that clicks and re-focuses
 * in the same breath and never sees this. What decides it is the browser's rule
 * about what a second click on a focused input does, which is nothing.
 *
 * `openspec/changes/picker-reopens-on-click/`.
 */
test('offers the rest of the directory when the add field is clicked again', async ({ page }) => {
  const { tags } = await seed(page);
  await showReferenceColumns(page);

  const box = page.getByRole('combobox', { name: 'Tags for 020', exact: true });
  /**
   * How many lines a `CreatablePicker` is offering.
   *
   * Scoped to `[data-picker-list]` and **not** `getByRole('option')`, which was
   * how this was first written: the toolbar holds two native `<select>`s — the
   * Mermaid axis (`outline`/`step`/`assignee`) and the estimate point
   * (`PERT`/`optimistic`/…) — whose seven `<option>` elements are in the
   * document at all times. `expect.poll(optionsOpen).toBe(0)` on a closed list
   * failed on `Expected: 0 · Received: 7` with nothing whatever wrong.
   */
  const optionsOpen = () => page.locator('[data-picker-list] [role="option"]').count();
  /**
   * The list is open, and it is offering the rest of the directory.
   *
   * **Open is a count and the membership is named — never a count of the
   * membership.** `toBe(2)` was how this was written, and the directory is
   * **global**: every project draws from one list on purpose
   * (`service_team`'s own comment), so `mobile.spec.ts`' `mobile e2e tag` is in
   * it too and the third line under this box belongs to another spec. It failed
   * at case 252 of 270 on `Expected: 2 · Received: 3` with the fix working
   * perfectly, and passed alone because nothing had created that tag yet. A
   * literal count against a shared directory is a test whose result depends on
   * which other specs have run.
   *
   * So the open-ness is `> 0` — which is what goes to zero when the fix is
   * removed, watched — and what the list must *contain* is asserted by name.
   */
  const expectOffersTheRest = async (where: string): Promise<void> => {
    expect(await optionsOpen(), where).toBeGreaterThan(0);
    for (const rest of tags.slice(1)) {
      await expect(page.getByRole('option', { name: rest.name, exact: true })).toBeVisible();
    }
    // And the one already on the row is not offered again, which is the other
    // half of what "the rest of the directory" means.
    await expect(page.getByRole('option', { name: tags[0].name, exact: true })).toHaveCount(0);
  };

  // The first add, through the cell as a reader does it: click in, take a line.
  await box.click();
  await expect(page.getByRole('option', { name: tags[0].name, exact: true })).toBeVisible();
  await page.getByRole('option', { name: tags[0].name, exact: true }).click();
  // **Scoped to this row's cell, and a page-wide locator here was a wait that
  // waited for nothing.** `seed` puts `tags[0]` and `tags[1]` on row `010`
  // already, so `page.locator('[data-reference-chip=…]')` matched 010's chip in
  // the first frame and this line returned before `020`'s write had left the
  // browser. Under the load of the whole gate the click below then landed on a
  // row the server had not yet been told about, the list correctly offered all
  // three tags, and the case failed on `Expected: 2 · Received: 3` — passing
  // alone and failing at #252 of 270.
  await expect(
    cellOf(page, 'Tags for 020').locator(`[data-reference-chip="${tags[0].id}"]`),
    'the tag never landed on 020',
  ).toBeVisible();

  // The take closed the list and left the focus where it was, which is the
  // state Dany's report is about.
  await expect(box).toBeFocused();
  await expect.poll(optionsOpen).toBe(0);

  // **The gesture.** A click on the box that already holds the focus.
  //
  // Proof: `onClick` deleted from `CreatablePicker`'s input, watched failing on
  // `clicking the focused add field offered nothing · Expected: > 0 · Received:
  // 0` — no list at all, which is the report word for word.
  await box.click();
  await expectOffersTheRest('clicking the focused add field offered nothing');

  // The `+` beside it is the other half of "the small add field", and it hands
  // the focus to a box that already has it — so without the same fix it is the
  // same dead click.
  await page.keyboard.press('Escape');
  await expect.poll(optionsOpen).toBe(0);
  await expect(box).toBeFocused();
  await page.getByRole('button', { name: 'Add a tag to 020', exact: true }).click();
  await expectOffersTheRest('the + offered nothing on a focused box');
});
