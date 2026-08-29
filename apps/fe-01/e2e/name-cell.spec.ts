import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The Name cell's height, in a browser.
 *
 * Every assertion in this file is one jsdom cannot make. The cell is one
 * `<textarea>` holding the name on its first line and the notes under it, and
 * what this change does to it is entirely a matter of layout: at rest the box
 * is as tall as its own wrapped name, the notes under it take no height and
 * cannot be scrolled to, and the focus opens the whole text. `scrollHeight` is
 * 0 in jsdom, so a unit test can watch the rules being written onto the node
 * and can never see the box they produce — which is the shape of R5 tally
 * #14–16, all three of them found by a browser after a green unit suite.
 *
 * The unit side is deliberately narrow for the same reason: `wbs-table.test.tsx`
 * asserts the clip and the value the box holds, and nothing about pixels.
 */

/** A name that fits the Name column on one line at 1400px. */
const SHORT_NAME = 'Strip the wiring';

/**
 * A name long enough to wrap onto several lines in the Name column.
 *
 * One logical line — no newline in it — so what wraps it is the column's
 * width, which is the case "the whole name, however many lines it takes" is
 * about.
 */
const LONG_NAME =
  'Survey the existing warehouse racking, photograph every aisle end, and mark the bays whose beams have been struck by a truck since the last inspection';

/** Ten lines of notes, which at rest must take no height at all. */
const TEN_LINES = [
  '## Risks',
  '',
  '- the fuse box is old',
  '- the loft hatch is painted shut',
  '- nobody has the key to the meter cupboard',
  '- the neighbour parks across the drive',
  '- two circuits are unlabelled',
  '- the survey was done in the dark',
  '- the ladder is one rung short',
  '- and the dog',
].join('\n');

/**
 * Signs up a throwaway account and makes a plan of `rows` empty work items.
 *
 * Through the UI, like the other browser gates: the box being measured is one
 * somebody has typed into, sized by the same render path a real session takes.
 */
async function seedRows(page: Page, _account: string, rows: number): Promise<void> {
  void _account;
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const addRow = page.getByRole('button', { name: 'Add work item' });
  for (let made = 1; made <= rows; made += 1) {
    await addRow.click();
    await expect(page.getByLabel(`Name of ${String(made * 10).padStart(3, '0')}`)).toBeVisible();
  }
}

/** Types `text` into a Name cell and leaves it, which is what saves it. */
async function writeInto(cell: Locator, text: string): Promise<void> {
  await cell.fill(text);
  await cell.blur();
}

interface CellBox {
  /** What the box is laid out at, which is the height under test. */
  clientHeight: number;
  /** The width the wrapping happens at — the Name column's, less its padding. */
  clientWidth: number;
  /** What its text would need. Above `clientHeight` means something is hidden. */
  scrollHeight: number;
  /** How far the box itself has been scrolled — the notes' way back into view. */
  scrollTop: number;
  /** One line of this box's text, which is the unit "a line is hidden" is in. */
  lineHeight: number;
  overflowY: string;
}

/** The one box's own geometry, read after the browser has laid it out. */
function boxOf(cell: Locator): Promise<CellBox> {
  return cell.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      clientHeight: node.clientHeight,
      clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      // Chromium answers `normal` for a `line-height` nothing set, and
      // `parseFloat('normal')` is `NaN` — which is how `layout.spec.ts` once
      // grew a precondition that could not fail. The font's own size is the
      // fallback the browser is describing.
      lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2,
      overflowY: style.overflowY,
    };
  });
}

/**
 * How much of this box's text is outside it, in lines.
 *
 * Lines rather than pixels because of a systematic pixel that has nothing to
 * do with this change: the Name cell is `box-sizing: border-box` and has a
 * 1px border, so a box laid out at exactly its `scrollHeight` reports one or
 * two pixels of overflow whatever is in it — measured here at 58 against 57
 * for a wrapped name, and at 202 against 201 for a focused cell showing ten
 * lines of notes. What "nothing is cut" means is that no *line* is hidden,
 * and that is what this asks.
 */
const linesHidden = (box: CellBox): number =>
  (box.scrollHeight - box.clientHeight) / box.lineHeight;

/**
 * One edit by somebody else, made the way somebody else makes it: a request to
 * be-01 from outside this page's own UI, which gw-01 then tells the page about.
 *
 * The same fixture `mobile.spec.ts` uses. Its same-origin request carries the
 * page's httpOnly session cookie because what is being measured is what
 * arrives at *this* page, not who sent it.
 */
async function aPeerRenames(page: Page, workItemId: string, name: string): Promise<void> {
  const status = await page.evaluate(
    async ([id, newName]) => {
      // A batch of one on the page's own project, as every write is now.
      const projectId = window.localStorage.getItem('wbs.project');
      if (projectId === null) throw new Error('no wbs.project in localStorage');
      const res = await fetch(`/api/projects/${projectId}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commands: [{ kind: 'patchWorkItem', workItemId: id, patch: { name: newName } }],
        }),
      });
      return res.status;
    },
    [workItemId, name] as const,
  );
  expect(status, 'the peer edit was refused by be-01').toBe(200);
}

/** The id be-01 knows this row by, which is what a peer edits it through. */
async function idOf(cell: Locator): Promise<string> {
  const id = await cell.getAttribute('data-name-input');
  expect(id, 'the name cell carries no work item id to rename by').not.toBeNull();
  return id ?? '';
}

/** Waits for the browser to have laid the page out again after a change. */
const settled = (page: Page): Promise<unknown> =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

let account = 0;

test.beforeEach(() => {
  account += 1;
});

test.describe('the Name cell at rest is the name alone', () => {
  test('at rest the cell is as tall as its wrapped name', async ({ page }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 3);

    const noted = page.getByLabel('Name of 010');
    const bare = page.getByLabel('Name of 020');
    const long = page.getByLabel('Name of 030');
    // The same name on both of the first two, so the only difference between
    // their boxes is ten lines of notes.
    await writeInto(noted, `${SHORT_NAME}\n${TEN_LINES}`);
    await writeInto(bare, SHORT_NAME);
    await writeInto(long, LONG_NAME);

    const withNotes = await boxOf(noted);
    const without = await boxOf(bare);
    const wrapped = await boxOf(long);

    // The precondition, and it is not a formality: if the notes had not been
    // stored, or the box had been left holding the name alone, the two heights
    // below would match for a reason that has nothing to do with the clamp.
    expect(await noted.inputValue()).toBe(`${SHORT_NAME}\n${TEN_LINES}`);
    expect(
      linesHidden(withNotes),
      'the noted cell has nothing hidden in it, so this test is not about hiding anything',
    ).toBeGreaterThan(5);

    expect(withNotes.clientHeight, 'the cell with ten lines of notes is taller at rest').toBe(
      without.clientHeight,
    );

    // And the name itself is never what gets cut: the long one wraps, so it is
    // taller than the short one, and all of it is on screen.
    expect(wrapped.clientHeight).toBeGreaterThan(without.clientHeight);
    expect(
      linesHidden(wrapped),
      'a line of the wrapped name is hidden inside its own box',
    ).toBeLessThan(0.5);
  });

  test('the notes cannot be scrolled into view at rest', async ({ page }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 1);

    const noted = page.getByLabel('Name of 010');
    await writeInto(noted, `${SHORT_NAME}\n${TEN_LINES}`);

    const box = await noted.boundingBox();
    expect(box, 'the name cell has to be on screen to be scrolled over').not.toBeNull();
    await page.mouse.move(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await page.mouse.wheel(0, 400);
    // The wheel is asynchronous in Chromium — the scroll it causes lands after
    // the event does — so the read below waits for a frame rather than racing
    // it and reporting the old zero.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    const after = await boxOf(noted);
    // The scroll first and the rule second: what must not happen is the notes
    // arriving, and `overflow-y` is only how that is prevented. A box left on
    // `auto` at its clamped height fails on this line, which is the fault the
    // rule below exists for — watched, rather than assumed from the rule.
    expect(after.scrollTop, 'the wheel scrolled the notes into view').toBe(0);
    expect(
      after.overflowY,
      'a clamped box that scrolls hands the notes back a wheel-turn at a time',
    ).toBe('hidden');
  });

  test('focus shows the notes and blur hides them again', async ({ page }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 1);

    const noted = page.getByLabel('Name of 010');
    await writeInto(noted, `${SHORT_NAME}\n${TEN_LINES}`);
    const atRest = await boxOf(noted);

    // Every write this look makes. A focus and a blur with nothing typed is
    // not an edit, and the clamp moving the value in and out of the box is
    // exactly the sort of thing that would turn one into one.
    const writes: string[] = [];
    page.on('request', (request) => {
      const method = request.method();
      if (method === 'PATCH' || method === 'POST' || method === 'DELETE') {
        writes.push(`${method} ${new URL(request.url()).pathname}`);
      }
    });

    await noted.click();
    await expect(noted).toBeFocused();
    const focused = await boxOf(noted);

    expect(focused.clientHeight).toBeGreaterThan(atRest.clientHeight);
    // The whole text on screen, not merely a taller box: nothing left over to
    // scroll to.
    expect(linesHidden(focused), 'the focused cell still hides a line of its text').toBeLessThan(
      0.5,
    );
    expect(focused.overflowY).toBe('auto');

    await noted.blur();
    await expect(noted).not.toBeFocused();
    const after = await boxOf(noted);

    expect(after.clientHeight, 'the cell stayed open after the focus left it').toBe(
      atRest.clientHeight,
    );
    expect(after.overflowY).toBe('hidden');
    expect(await noted.inputValue()).toBe(`${SHORT_NAME}\n${TEN_LINES}`);
    expect(writes, 'a look through the cell wrote to the plan').toEqual([]);
  });

  /**
   * The one path that writes a value into the box **after** the box has been
   * measured: `LiveField.leave()`'s "nothing was typed" branch.
   *
   * A peer's edit that arrives while somebody has the cell open is held back by
   * rule 2 until they leave it, and the face measures the clamp on the blur —
   * before that branch runs. So the box is sized for the name it was showing
   * and then handed a longer one, which `overflow: hidden` then cuts. Nothing
   * re-measures afterwards: no request goes out, so no refetch and no render.
   *
   * Typed and typed back, rather than never touched: rule 2 only holds a peer's
   * edit back once somebody has typed in the cell, and a keystroke undone is
   * the ordinary way to arrive there.
   */
  test("a peer's longer name arriving while the cell is focused is whole once it is left", async ({
    page,
  }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 2);

    const mine = page.getByLabel('Name of 010');
    const theirs = page.getByLabel('Name of 020');
    await writeInto(mine, SHORT_NAME);
    await writeInto(theirs, SHORT_NAME);
    const atRest = await boxOf(mine);

    await mine.click();
    await expect(mine).toBeFocused();
    await mine.press('X');
    await mine.press('Backspace');
    expect(await mine.inputValue(), 'the cell was left holding the keystroke').toBe(SHORT_NAME);

    await aPeerRenames(page, await idOf(mine), LONG_NAME);
    // The second row is the witness that the refetch landed: it is renamed
    // after the first and nobody is holding it back, so its new name on screen
    // means the tree carrying *both* names has been rendered.
    await aPeerRenames(page, await idOf(theirs), 'Their new name');
    await expect(theirs).toHaveValue('Their new name');

    // The precondition, and the fault needs it: rule 2 kept the peer's name out
    // of the box while the focus was here, so the blur is the first moment it
    // can arrive.
    expect(await mine.inputValue(), 'the peer edit was written into the box mid-visit').toBe(
      SHORT_NAME,
    );
    await expect(mine).toBeFocused();

    await mine.blur();
    await expect(mine).not.toBeFocused();

    expect(await mine.inputValue(), 'the peer name never reached the box').toBe(LONG_NAME);
    const after = await boxOf(mine);
    expect(linesHidden(after), "a line of the peer's name is hidden after the blur").toBeLessThan(
      0.5,
    );
    expect(after.clientHeight, 'the box was never re-measured for the longer name').toBeGreaterThan(
      atRest.clientHeight,
    );
  });

  /**
   * The clamp measures by putting the first line in the box alone for one
   * `scrollHeight` read, and a `textarea`'s `value` setter drops the selection
   * — on an unfocused box as much as a focused one.
   *
   * Chromium keeps `selectionStart`/`selectionEnd` on a box the focus has left
   * (this test is the experiment; a run of it against the unsaved swap reports
   * the caret at the end of the whole text instead), and restores that range
   * when the focus comes back without placing a new caret. So a range somebody
   * selected and stepped away from is theirs to come back to, and the
   * measurement must leave no trace of itself.
   *
   * The focus is put back through `focus()` rather than through the grid's own
   * Shift+Tab, and that is a fact about this table rather than a convenience:
   * Tab and Shift+Tab arrive in a cell by `focusCellAt(input, 'all')`, which
   * selects the whole value on purpose. The retained range is what a click back
   * into the window, or a `focus()` that places no caret, comes back to.
   */
  test('a selection left in the name survives the measurement the blur makes', async ({ page }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 1);

    const noted = page.getByLabel('Name of 010');
    await writeInto(noted, `${SHORT_NAME}\n${TEN_LINES}`);

    await noted.click();
    await expect(noted).toBeFocused();
    // The range a drag over the word leaves, set through the API a drag ends in.
    await noted.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(6, 9, 'forward');
    });

    // Away with the key that leaves a cell. It moves the focus to the next
    // cell of the row and selects *that* box's text; this box's selection is
    // nobody's business but the browser's from here.
    await noted.press('Tab');
    await expect(noted).not.toBeFocused();

    const left = await noted.evaluate((node: HTMLTextAreaElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      direction: node.selectionDirection,
      length: node.value.length,
    }));
    expect(
      { start: left.start, end: left.end },
      'the measurement moved the caret of a box nobody was in',
    ).toEqual({ start: 6, end: 9 });
    expect(left.direction).toBe('forward');
    // A witness that the assertion above is not the caret's default: the whole
    // text is much longer than the range, and `value =` would have parked the
    // caret at the end of it.
    expect(left.length).toBeGreaterThan(9);

    await noted.evaluate((node: HTMLTextAreaElement) => {
      node.focus();
    });
    await expect(noted).toBeFocused();
    const back = await noted.evaluate((node: HTMLTextAreaElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
    }));
    expect(back, 'the selection was gone when the focus came back to it').toEqual({
      start: 6,
      end: 9,
    });
  });

  /**
   * The clamped height is measured at the box's width, and the width changes
   * without anybody touching the cell: a window dragged narrower gives the Name
   * column — the one column that takes whatever the fixed ones leave — fewer
   * pixels, and a name that fitted two lines needs four.
   *
   * Under the old `max-height` in `em` that staleness was scrollable. Under the
   * clamp it is `overflow: hidden`, so the lines the name grew are simply not
   * there.
   */
  test('a name that wraps further in a narrower window is still shown whole', async ({ page }) => {
    await seedRows(page, `e2e-name-${String(Date.now())}-${String(account)}`, 1);

    // Optional Tag/Service columns are backed by global vocabularies and may
    // have been created by a parallel test. Size both viewports from the table
    // that actually rendered so Name has slack first and then loses it.
    const tableMinWidth = await page.evaluate(() =>
      Number.parseInt(document.querySelector('table')?.style.minWidth ?? '', 10),
    );
    expect(tableMinWidth).toBeGreaterThan(0);
    await page.setViewportSize({ width: tableMinWidth + 400, height: 900 });
    await settled(page);

    const long = page.getByLabel('Name of 010');
    await writeInto(long, LONG_NAME);
    const wide = await boxOf(long);
    expect(linesHidden(wide), 'the name is already cut at the width it was typed at').toBeLessThan(
      0.5,
    );

    // Narrower, and still a table: keep 80px of slack over the rendered floor,
    // rather than assuming which optional columns another test has created.
    await page.setViewportSize({ width: tableMinWidth + 80, height: 900 });
    await settled(page);

    const narrow = await boxOf(long);
    // The precondition, and it is about the column rather than the box: a
    // window change that left the Name column the same width would make this
    // test pass with nothing re-measuring anything.
    expect(
      narrow.clientWidth,
      'the Name column did not get narrower, so this test measures nothing',
    ).toBeLessThan(wide.clientWidth);
    expect(
      linesHidden(narrow),
      'a line of the name is hidden after the window was made narrower',
    ).toBeLessThan(0.5);
    // The same fact from the other side: the name needs more lines at this
    // width, so the box the clamp allows it is taller than it was.
    expect(narrow.clientHeight, 'the box was never re-measured at the new width').toBeGreaterThan(
      wide.clientHeight,
    );
  });
});

/**
 * The grip the Name cell put on its own `<textarea>`, and what it cost.
 *
 * A browser draws a resize handle in the bottom-right corner of a textarea, and
 * the Name cell's own `style` object set `resize: 'vertical'`, so every Name
 * cell in this table shipped with one. **Not** Tailwind's preflight, which this
 * build never imports and whose served CSS carries no `resize` rule at all —
 * this docstring said preflight until 2026-08-12, and it mattered, because an
 * inline property outranks every layer and a stylesheet rule could not have
 * reached the box while it was there. `styles.css`'s `[data-grid] textarea`
 * block and `verify.md`'s defect 1 have the correction.
 *
 * Dragging it is not an edit and there is no undo for it: the row's
 * box takes the dragged height, the chart row beside it keeps the height the
 * plan gave it, and the two are out of line for the rest of the session.
 * Measured on dev, 2026-08-12 — one drag took a 28px row to 124px.
 *
 * A browser is the only oracle for it. jsdom performs no drag, lays nothing
 * out and reports no `resize` — this is R5 #14–16's fault class, which is why
 * the pin is here and not in `wbs-table.test.tsx`.
 */
test.describe('the Name cell has no grip to drag it out of line', () => {
  test('dragging the bottom-right corner leaves the row the height its text asks for', async ({
    page,
  }) => {
    await seedRows(page, `e2e-grip-${String(Date.now())}-${String(account)}`, 2);
    const cell = page.getByLabel('Name of 010');
    await writeInto(cell, SHORT_NAME);
    await settled(page);

    const before = await boxOf(cell);
    const row = page.locator('tbody tr').first();
    const rowBefore = await row.evaluate((node) => node.getBoundingClientRect().height);

    const grip = await cell.boundingBox();
    expect(grip, 'the Name cell has no box to take a corner of').not.toBeNull();
    if (grip === null) return;
    // The last two pixels inside the box's bottom-right corner, which is where
    // a browser puts the handle.
    await page.mouse.move(grip.x + grip.width - 2, grip.y + grip.height - 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width - 2, grip.y + grip.height + 96, { steps: 12 });
    await page.mouse.up();
    await settled(page);

    const after = await boxOf(cell);
    const rowAfter = await row.evaluate((node) => node.getBoundingClientRect().height);

    expect(
      await cell.evaluate((node) => getComputedStyle(node).resize),
      'the box still offers a resize handle',
    ).toBe('none');
    expect(after.clientHeight, 'the drag changed the height of the Name box').toBe(
      before.clientHeight,
    );
    expect(rowAfter, 'the drag changed the height of the row').toBe(rowBefore);
  });

  test('the box still grows with the text it is given', async ({ page }) => {
    // The other half, and what makes the rule above a rule rather than a box
    // frozen at one height: `resize: none` is about the *handle*, and the
    // auto-grow that writes `style.height` is untouched by it.
    await seedRows(page, `e2e-grow-${String(Date.now())}-${String(account)}`, 2);
    const cell = page.getByLabel('Name of 010');
    await writeInto(cell, SHORT_NAME);
    await settled(page);
    const short = await boxOf(cell);

    await writeInto(cell, LONG_NAME);
    await settled(page);
    const long = await boxOf(cell);

    expect(long.clientHeight, 'a wrapped name did not make the box taller').toBeGreaterThan(
      short.clientHeight,
    );
    expect(linesHidden(long), 'a line of the wrapped name is hidden').toBeLessThan(0.5);
  });
});
