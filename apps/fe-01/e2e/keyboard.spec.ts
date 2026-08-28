import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The command chords, in a browser.
 *
 * `wbs-table.test.tsx` proves the routing matrix — chord × cell class ×
 * picker-open — and it proves it against events a test constructed. Three
 * things are outside what jsdom can say anything about, and each of them is a
 * test in here:
 *
 * 1. **Ordering against a real event loop.** Cmd+Enter flushes the cell, waits
 *    for be-01 to answer, and only then creates. The unit test holds a fake
 *    open to see it; this one runs it against three real servers, where the
 *    round trip is a real one and the refetch it triggers is a real render.
 * 2. **A real `keyup`.** Ctrl+D's second press waits for D to have been let go,
 *    and jsdom only ever sees the `keyup` a test chose to fire. Here the
 *    keyboard sends both halves of every press.
 * 3. **A real newline.** Enter in the Name cell is the browser's own default
 *    action, which jsdom does not perform at all: a synthetic keydown leaves
 *    the value untouched whether the key was prevented or not. Only a browser
 *    can say the note went in and the box grew to hold it.
 *
 * What none of this can prove is the one thing `tools/dev/chord-probe.html`
 * exists for: Playwright dispatches into the page, so a chord the operating
 * system would have eaten arrives here regardless.
 */

/**
 * Signs up a throwaway account and makes a plan of `rows` empty work items.
 *
 * Through the UI, like the layout gate's own seed: what is being measured is
 * what the keyboard does to a table somebody has actually been typing in.
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

/**
 * Puts the plan on a calendar, which is what the earliest-start cells need
 * before they will open at all: without a project start date there is no day
 * zero and be-01 ignores the constraint, so the column is a rendered disabled
 * state.
 */
async function setProjectStart(page: Page): Promise<void> {
  // `fill` is a **pick** since 2026-08-23 — it sets the value and fires
  // `input`/`change` with no keydown, and a keyless change is a day the browser
  // put in the box, which `DateField` sends at once. So the write leaves here
  // rather than on the blur below; the blur stays because it is what a person
  // does and because it has to stay silent. The `toBeEnabled` wait is what
  // holds until the refetch that write starts has landed.
  await page.getByLabel('Project start date').fill('2026-06-01');
  await page.getByLabel('Project start date').blur();
  await expect(page.getByLabel('Earliest start for 010', { exact: true })).toBeEnabled();
}

/**
 * Delivers a day the way Chrome's own calendar popup delivers one: the value
 * arrives in the box, the focus stays in it, and **no key is pressed**.
 *
 * **Through the native prototype setter.** React installs an instance-level
 * `value` setter on every input it renders, to dedupe `change` against the
 * value it last saw; assigning `node.value` goes through it, updates React's
 * tracker, and React drops the event as "nothing changed" — so `onChange` never
 * runs and the test measures the harness. The descriptor off
 * `HTMLInputElement.prototype` steps around the tracker, which is what the
 * browser's picker does.
 *
 * Watched, 2026-08-23: the case below passed with a plain `node.value = …`
 * only because the commit it checked came from the **blur afterwards** — the
 * pick itself was never seen by the component at all. `e2e/gantt.spec.ts` has
 * the same helper for the same reason.
 */
async function pickDay(box: Locator, day: string): Promise<void> {
  await box.evaluate((node, chosen) => {
    if (!(node instanceof HTMLInputElement)) throw new Error('that is not a date input');
    // Bound at the point it is taken off the prototype: an unbound setter is a
    // `this` waiting to be the wrong object, and `.bind` is what the lint rule
    // that catches it asks for.
    const assign = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
      node,
    );
    if (assign === undefined) throw new Error('HTMLInputElement has no value setter to borrow');
    node.focus();
    assign(chosen);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, day);
}

/** Every work item number on screen, top to bottom. */
function numbersOnScreen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('tbody [data-number]')].map((node) => node.textContent),
  );
}

let account = 0;

/**
 * Puts the Teams column on the table, which `configurable-columns` hides by
 * default, and closes the control again so its panel is not over the cells.
 */
async function showTeamsColumn(page: Page): Promise<void> {
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Teams' }).check();
  await expect(page.locator('thead th[data-column="team"]')).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
}

test.beforeEach(() => {
  account += 1;
});

test.describe('the command chords, in a browser', () => {
  test('types a note under a name with Enter, and the box grows to hold it', async ({ page }) => {
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);

    const name = page.getByLabel('Name of 010');
    await name.click();
    await name.pressSequentially('Strip the old wiring');
    const oneLine = await name.boundingBox();
    expect(oneLine, 'the name cell has to be on screen').not.toBeNull();

    // The chord this whole change exists to make possible. jsdom performs no
    // default action for a synthetic key, so this line is the only place in
    // the repository where Enter actually puts a newline into the box.
    await page.keyboard.press('Enter');
    await page.keyboard.type('measure twice, the fuse box is old');

    await expect(name).toHaveValue('Strip the old wiring\nmeasure twice, the fuse box is old');
    const grown = await name.boundingBox();
    expect(grown, 'the name cell has to still be on screen').not.toBeNull();
    // `autoSize` following the value, which is what stops a note being written
    // into a one-line box nobody can read back. Both boxes here are measured
    // with the caret in the cell — at rest it clamps back to the name alone,
    // which is `e2e/name-cell.spec.ts`'s subject and not this test's.
    expect(grown?.height ?? 0).toBeGreaterThan(oneLine?.height ?? 0);

    await name.blur();
    // Two fields on the server, from one box: the first line is the name and
    // the rest is the note. Read back off the reloaded page, so this is be-01's
    // answer rather than the DOM's memory of what was typed.
    await page.reload();
    await expect(page.getByLabel('Name of 010')).toHaveValue(
      'Strip the old wiring\nmeasure twice, the fuse box is old',
    );
  });

  test('Cmd+Enter saves the cell before it creates the row it lands in', async ({ page }) => {
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 2);

    // The two writes this chord makes: `PATCH /api/work-items/:id` saves the
    // name, `POST /api/projects/:id/work-items` makes the row. Reads and the
    // refetches they trigger are left out — this is about which of the two
    // writes went first.
    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const method = request.method();
      if (method !== 'PATCH' && method !== 'POST') {
        await route.continue();
        return;
      }
      writes.push(`${method} ${new URL(request.url()).pathname}`);
      // The save held open for half a second, so "did it wait for the answer"
      // is a question with a window to ask it in. Only the save: delaying the
      // create as well would say nothing about which came first.
      if (method === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    const last = page.getByLabel('Name of 020');
    await last.click();
    await last.pressSequentially('Sand the frames');

    await page.keyboard.press('ControlOrMeta+Enter');

    // While the save is still out, nothing has been created. The order the two
    // requests *go out* in cannot see the fault — both leave synchronously
    // either way, and the first version of this test passed with the `await`
    // dropped for exactly that reason. What an unawaited flush loses is the
    // answer, so this is asserted inside the window the delay above holds
    // open.
    await expect(page.getByLabel('Name of 030')).toHaveCount(0);
    expect(writes.filter((each) => each.startsWith('POST'))).toHaveLength(0);

    await expect(page.getByLabel('Name of 030')).toBeVisible();
    await expect(page.getByLabel('Name of 030')).toBeFocused();
    await expect(page.getByLabel('Name of 020')).toHaveValue('Sand the frames');

    // The save first, the create second — the ordering the unit test asserts
    // against a held promise, here against a real round trip.
    const made = writes.join(', ');
    expect(writes.at(0), `the writes this chord made were ${made}`).toMatch(/^PATCH \/api\/work-/);
    expect(writes.at(1), `the writes this chord made were ${made}`).toMatch(
      /^POST \/api\/projects/,
    );
    expect(writes.filter((each) => each.startsWith('POST'))).toHaveLength(1);
  });

  test('a chord after a blur whose save is still out waits for that save', async ({ page }) => {
    // codex round 2, finding 1, against a real event loop. The cell drops a
    // resubmission of a request that is already out — the blur, then a click
    // back into the unchanged cell — and the chord that flushes it in that
    // window used to be told "nothing was sent". It read that as permission to
    // create, and a refusal would then have arrived after the row existed.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 2);

    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const method = request.method();
      if (method !== 'PATCH' && method !== 'POST') {
        await route.continue();
        return;
      }
      writes.push(`${method} ${new URL(request.url()).pathname}`);
      // Two seconds, so the window to ask the question in is far wider than
      // anything Playwright's own actions cost.
      if (method === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    const last = page.getByLabel('Name of 020');
    await last.click();
    await last.pressSequentially('Sand the frames');
    // The blur is what sends it; the click back in is what makes the chord's
    // flush a duplicate of a request nobody has heard back from yet.
    await last.blur();
    await last.click();
    await page.keyboard.press('ControlOrMeta+Enter');

    await page.waitForTimeout(700);
    // Still inside the held window: nothing created, and the caret has not
    // moved out of the only copy of what was typed.
    expect(writes.filter((each) => each.startsWith('POST'))).toHaveLength(0);
    expect(await page.getByLabel('Name of 030').count()).toBe(0);
    await expect(last).toBeFocused();

    // And waiting is not refusing: the save lands, and the chord it was
    // holding happens.
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    await expect(page.getByLabel('Name of 030')).toBeFocused();
    await expect(page.getByLabel('Name of 020')).toHaveValue('Sand the frames');
    expect(writes.filter((each) => each.startsWith('PATCH'))).toHaveLength(1);
    expect(writes.filter((each) => each.startsWith('POST'))).toHaveLength(1);
  });

  test('Cmd+Enter in an open team picker takes no entry and creates none', async ({ page }) => {
    // codex round 2, finding 2, where a browser can say what jsdom cannot: the
    // chord arrived as a real keystroke through a real combobox, and no write
    // left the page. The list was suppressing the table's handler and then
    // reading the same key as its own bare Enter.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);
    await showTeamsColumn(page);

    const writes: string[] = [];
    await page.route('**/api/**', async (route) => {
      const method = route.request().method();
      if (method === 'PATCH' || method === 'POST') {
        writes.push(`${method} ${new URL(route.request().url()).pathname}`);
      }
      await route.continue();
    });

    // By role, not by label: the list this box opens carries the same
    // `aria-label` — it is the accessible name of the pair — so `getByLabel`
    // matches both and Playwright refuses in strict mode. Observed on h2puni,
    // 2026-08-08.
    const team = page.getByRole('combobox', { name: 'Service or team for 010' });
    await team.click();
    await team.pressSequentially('Platform');
    await expect(page.getByRole('listbox', { name: 'Service or team for 010' })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+Enter');
    await page.waitForTimeout(700);

    // No team added, no work item labelled with one, and no row created: the
    // chord was consumed by the open list and did nothing at all.
    expect(writes).toEqual([]);
    expect(await page.getByLabel('Name of 020').count()).toBe(0);
    // The search is still there to go on typing.
    await expect(team).toHaveValue('Platform');
  });

  test('Ctrl+D arms on the first press and deletes on the second', async ({ page }) => {
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 3);

    const second = page.getByLabel('Name of 020');
    await second.click();
    await second.pressSequentially('Sand the frames');
    await second.blur();
    await second.click();

    // A real press: keydown, then keyup. The keyup is the half jsdom only ever
    // sees because a test chose to send it, and the half the confirm waits for.
    await page.keyboard.press('Control+d');

    await expect(page.locator('tr[data-armed="true"] [data-number]')).toHaveText('020');
    await expect(page.getByText('Ctrl+D again deletes 020 — its children move up')).toBeVisible();
    // Still three rows: nothing is destroyed on one gesture.
    expect(await numbersOnScreen(page)).toEqual(['010', '020', '030']);

    await page.keyboard.press('Control+d');

    await expect(page.getByText('Deleted 020 — Cmd+Z restores')).toBeVisible();
    expect(await numbersOnScreen(page)).toEqual(['010', '020']);
    // The row that took its place holds the name the deleted one did not.
    await expect(page.getByLabel('Name of 020')).not.toHaveValue('Sand the frames');
    // Counted once, not `expect(locator).toHaveCount(0)`: that assertion
    // retries for ten seconds, and an arm takes itself off after three — so
    // the retrying form waits out the timer and passes against a row that
    // really was armed. Watched doing exactly that on h2puni, 2026-08-08,
    // with the `repeat` guard removed.
    expect(await page.locator('tr[data-armed="true"]').count()).toBe(0);
  });

  test('a key still held when the row goes does not arm the row after it', async ({ page }) => {
    // What `event.repeat` uniquely buys, through a real keyboard: the second
    // press confirms on its first keydown, and the auto-repeats that follow
    // arrive while the row is being deleted. Whatever slides up into the gap
    // must not end up armed by a key nobody pressed again.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 3);

    await page.getByLabel('Name of 020').click();
    await page.keyboard.press('Control+d');
    await expect(page.locator('tr[data-armed="true"] [data-number]')).toHaveText('020');

    // Held down for the confirming press: the first `down` is the press that
    // deletes, and each `down` after it — of a key already down — is an
    // auto-repeat, `repeat: true`, exactly as a real held key produces. A
    // `waitForTimeout` here would prove nothing: Playwright does not repeat a
    // key on its own, and the first version of this test held one for 800ms
    // and saw a single keydown.
    await page.keyboard.down('Control');
    await page.keyboard.down('d');
    for (let repeated = 0; repeated < 6; repeated += 1) {
      await page.keyboard.down('d');
      await page.waitForTimeout(80);
    }
    await page.keyboard.up('d');
    await page.keyboard.up('Control');

    await expect(page.getByText('Deleted 020 — Cmd+Z restores')).toBeVisible();
    expect(await numbersOnScreen(page)).toEqual(['010', '020']);
    // Counted once, not `expect(locator).toHaveCount(0)`: that assertion
    // retries for ten seconds, and an arm takes itself off after three — so
    // the retrying form waits out the timer and passes against a row that
    // really was armed. Watched doing exactly that on h2puni, 2026-08-08,
    // with the `repeat` guard removed.
    expect(await page.locator('tr[data-armed="true"]').count()).toBe(0);
  });

  test('arming one row and pressing Ctrl+D in another arms the second, and deletes neither', async ({
    page,
  }) => {
    // The scenario, in a browser — but not a proof of the same-row conjunct,
    // and the difference is worth stating. Reaching another row here means
    // moving the focus, and a focus change disarms before the second press
    // ever arrives; the same-row check is what catches the case the focus rule
    // cannot see, and it is watched failing in `wbs-table.test.tsx`, where a
    // key can be aimed at a row without the focus following it. Two guards,
    // one outcome, and this is the one a person actually performs.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 3);

    await page.getByLabel('Name of 020').click();
    await page.keyboard.press('Control+d');
    await expect(page.locator('tr[data-armed="true"] [data-number]')).toHaveText('020');

    await page.getByLabel('Name of 030').click();
    await page.keyboard.press('Control+d');

    await expect(page.locator('tr[data-armed="true"] [data-number]')).toHaveText('030');
    expect(await numbersOnScreen(page)).toEqual(['010', '020', '030']);
  });

  test('a modified Enter or Space on a menu item takes nothing', async ({ page }) => {
    // The one leak jsdom cannot see. A `<button>` fires a click of its own from
    // Enter and from Space unless the keydown was prevented, and the item's
    // modifier guard used to return *before* `preventDefault` — so Chrome
    // synthesized the click and the item ran. Observed live on 2026-08-09:
    // menu open on a row, Cmd+Enter, and the row was duplicated.
    //
    // Three modified activations rather than one, because which of them a
    // platform delivers is the platform's business: ⌘/Ctrl+Enter is the
    // table's own next-or-create chord, and Shift+Enter and Shift+Space are
    // the two the browser probe caught clicking as well.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 2);

    await page.getByRole('button', { name: 'Actions for 010' }).click();
    const duplicate = page.getByRole('menuitem', { name: 'Duplicate' });
    await expect(duplicate).toBeFocused();

    for (const chord of ['ControlOrMeta+Enter', 'Shift+Enter', 'Shift+Space']) {
      await page.keyboard.press(chord);
      await page.waitForTimeout(200);
      // Nothing taken, and the menu is still open under the hand that is
      // reading it: an item that ran would have closed it on the way out.
      expect(await numbersOnScreen(page), `after ${chord}`).toEqual(['010', '020']);
      await expect(duplicate, `after ${chord}`).toBeVisible();
      await expect(duplicate, `after ${chord}`).toBeFocused();
    }

    // And the bare key still does what the menu is for.
    await page.keyboard.press('Enter');
    // The copy lands next to its original, so the row that proves it arrived
    // is the third one — `Name of 020` was on screen before the duplicate too.
    await expect(page.getByLabel('Name of 030')).toBeVisible();
    expect(await numbersOnScreen(page)).toEqual(['010', '020', '030']);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('a modified Enter, Space or ↓ does not open the ⋯ menu', async ({ page }) => {
    // The same fault one handler along, and a direct one rather than a default
    // click: the opening button recognized Enter, Space and ↓ and opened on
    // them with no modifier guard at all, so every chord aimed at the plan
    // opened a menu over the row it was aimed at.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);

    const opener = page.getByRole('button', { name: 'Actions for 010' });
    await opener.focus();

    for (const chord of ['ControlOrMeta+Enter', 'Shift+Enter', 'Shift+Space', 'Alt+ArrowDown']) {
      await page.keyboard.press(chord);
      await page.waitForTimeout(200);
      expect(await page.getByRole('menu').count(), `after ${chord}`).toBe(0);
      await expect(opener, `after ${chord}`).toHaveAttribute('aria-expanded', 'false');
    }

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
  });

  test('a click opens the earliest-start editor, which a mousedown did not', async ({ page }) => {
    // R5 #14/#15's fault class, found again and in a browser again. Opening the
    // editor from `onMouseDown` mounted it inside the `mousedown` dispatch —
    // React flushes a discrete update there — so the at-rest input was gone
    // before Chromium performed that event's **default action**, focusing the
    // node it had hit-tested. Focusing a detached node moves the focus to
    // `<body>`; that blurred the editor; a blur is an exit; the editor closed.
    // A click on the cell did nothing at all, and jsdom — which performs no
    // default action — could see the handler and never the outcome.
    //
    // Proof: `onClick` on the at-rest earliest-start input changed back to
    // `onMouseDown`, this failed on `Expected: 1 / Received: 0` — no editor on
    // the page after the click — while every case in `wbs-table.test.tsx`
    // stayed green, because they open it with Enter. Watched, 2026-08-09.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);
    await setProjectStart(page);

    await page.getByLabel('Earliest start for 010', { exact: true }).click();

    await expect(page.locator('tbody input[type="date"]')).toHaveCount(1);
    await expect(page.locator('tbody input[type="date"]')).toBeFocused();
  });

  test('Escape leaves the stored day alone, blur and all', async ({ page }) => {
    // The half of the edit-exit contract jsdom cannot reach. Escape closes the
    // editor, closing gives the focus back to the cell, and giving the focus
    // back **blurs the editor** — the very gesture that abandoned the edit
    // would otherwise commit it. The unit suite cannot see that: the editor is
    // unmounted on the way out and an unmounted field receives no blur, so a
    // synthetic one would be a check that could not fail.
    //
    // Proof: the whole `event.key === 'Escape'` branch removed from
    // `date-field.tsx`, this failed on `Expected: 0 / Received: 1` — the editor
    // still open, Escape having done nothing at all. Watched, 2026-08-09.
    //
    // What this test does **not** prove is the blur: the editor is unmounted on
    // the way out, so there is no blur here to send anything. The field that
    // does stay on screen is the toolbar's, and its own test above is where
    // that half is watched.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);
    await setProjectStart(page);

    await page.getByLabel('Earliest start for 010', { exact: true }).click();
    const editor = page.locator('tbody input[type="date"]');
    // **Typed, not `fill`ed, and the difference is the subject of this test.**
    // Since 2026-08-23 a `fill` is a picked day — value set, no keydown — and a
    // pick is sent the moment it lands, so a filled date here would already be
    // at the server and there would be nothing for Escape to abandon. Escape
    // cancels a *typed* edit; typing is therefore the only gesture that can put
    // this test in the state it claims to be testing.
    //
    // Watched, 2026-08-23: with `fill`, this failed on `Expected: "—" /
    // Received: "1 Jul"` — the day saved before Escape was ever pressed.
    await editor.pressSequentially('07012026', { delay: 30 });
    await expect(editor).toHaveValue('2026-07-01');
    await page.keyboard.press('Escape');

    await expect(page.locator('tbody input[type="date"]')).toHaveCount(0);
    // The cell has the focus back, and the day the row never had.
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('—');
    // And it is still gone after a reload, which is the only thing that can say
    // be-01 was never told.
    await page.reload();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('—');
  });

  test('Escape puts the project start date back, and leaving it does not send the abandoned day', async ({
    page,
  }) => {
    // The one date field on this page that is **not** unmounted by Escape: the
    // toolbar's project start date is always on screen, so the blur an Escape
    // is followed by is a real blur on a live element — and it is the only
    // place the "nothing will be sent afterwards" half of the contract can be
    // observed at all.
    //
    // A flag suppressing that blur was written first and deleted for exactly
    // that reason: with the row editor unmounted on the way out there is no
    // blur to suppress, and here the flag sat behind the value reset and was
    // never reached. Watched passing with the flag removed, which is what a
    // check that cannot fail looks like.
    //
    // Proof: `node.value = agreed.current` removed from the Escape branch of
    // `date-field.tsx`, this failed on `expected "2026-09-09" to be
    // "2026-06-01"` — the abandoned day committed by the blur and saved.
    // Watched, 2026-08-09.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);
    await setProjectStart(page);

    const starts = page.getByLabel('Project start date');
    // Typed rather than `fill`ed, for the reason the row's case above gives:
    // a `fill` is a pick now and a pick is already sent, so it would leave this
    // test nothing to abandon. `pressSequentially` focuses the box itself,
    // which also puts the caret on the first segment — clicking it first would
    // put the caret wherever the pointer landed.
    await starts.pressSequentially('09092026', { delay: 30 });
    await expect(starts).toHaveValue('2026-09-09');
    await page.keyboard.press('Escape');

    // Put back in the box, before anything has been sent.
    await expect(starts).toHaveValue('2026-06-01');

    // And left, which is the gesture that used to send it.
    await page.getByLabel('Name of 010').click();

    await expect(starts).toHaveValue('2026-06-01');
    await page.reload();
    await expect(page.getByLabel('Project start date')).toHaveValue('2026-06-01');
  });

  test('saves a day picked from the native calendar when the field is left', async ({ page }) => {
    // Chrome returns the focus to the input when its own picker closes, so
    // there is no earlier moment this component can see than the field being
    // left — which is why `DateField` commits on the way out rather than on
    // `change`. jsdom has no picker and no default action; only a browser can
    // say the picked day survived.
    //
    // The pick is delivered as the browser delivers one — a `change` the
    // element itself fires, with the focus still in the box — rather than as
    // typing, which is the case `holds a date typed one segment at a time`
    // already covers in jsdom.
    //
    // Proof: the editor's `commit` in `wbs-table.tsx` cut to
    // `() => undefined`, this failed on `Expected: "3 Jul" / Received: "—"` —
    // the picked day never leaving the box. Watched, 2026-08-09.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 2);
    await setProjectStart(page);

    await page.getByLabel('Earliest start for 010', { exact: true }).click();
    const editor = page.locator('tbody input[type="date"]');
    await pickDay(editor, '2026-07-03');
    await expect(page.locator('tbody input[type="date"]')).toHaveCount(1);

    // Left by clicking another row's name, which is what a person does next.
    await page.getByLabel('Name of 020').click();

    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('3 Jul');
    await page.reload();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('3 Jul');
  });

  test('does not lose the edit to a Tab out of the date segments', async ({ page }) => {
    // **Tab does not leave a date input in Chrome**: it steps between the day,
    // month and year segments, so a keyboard leaves this box on the third Tab.
    // Measured rather than assumed on 2026-08-09 — `document.activeElement` was
    // still the box after one Tab — and this is what says the day survives the
    // whole trip.
    //
    // Proof: the editor's `commit` in `wbs-table.tsx` cut to
    // `() => undefined`, this failed on `Expected: "5 Jul" / Received: "—"`.
    // Watched, 2026-08-09.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 2);
    await setProjectStart(page);

    await page.getByLabel('Earliest start for 010', { exact: true }).click();
    const editor = page.locator('tbody input[type="date"]');
    await editor.fill('2026-07-05');

    // Three, which is what it takes: Chrome's date input steps between its
    // day, month and year segments before the key leaves the box at all.
    for (let press = 0; press < 3; press += 1) await page.keyboard.press('Tab');

    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('5 Jul');
    await page.reload();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('5 Jul');
  });

  test('saves only the year that was typed, digit by digit, in a real Chrome', async ({ page }) => {
    // **The other half of the keydown rule, and the half jsdom cannot own.**
    // Since 2026-08-23 a `change` with no key behind it is a picked day and is
    // sent at once (`date-field.tsx`); the guard that keeps the year-`0002`
    // fault dead is that real typing fires a `keydown` per digit *before* the
    // `change` that digit completes. `date-field.test.tsx` can be told there
    // was a key. Only a browser can say there really is one, and only a browser
    // types `2026` as `0002`, `0020`, `0202`, `2026` in the first place.
    //
    // Proof: `typedSinceFocus.current = true` removed from `onKeyDown`, this
    // fails on `Expected: "20 May" / Received: "17 Aug"` — the year committed
    // as `0002`, the refetch answering over the caret, and the rest of the
    // digits landing in a box that had already moved on. Watched, 2026-08-23.
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 1);
    await setProjectStart(page);

    await page.getByLabel('Earliest start for 010', { exact: true }).click();
    const editor = page.locator('tbody input[type="date"]');
    await expect(editor).toHaveAttribute('type', 'date');
    // **No second click on the editor, and that is not tidying.** A click on a
    // date input puts the caret on whichever segment is under the pointer, so
    // clicking the middle of the box starts the typing at the day or the year
    // and `05202026` then lands as segments nobody asked for — with the first
    // written version of this case the box read `''` afterwards, a date too
    // incomplete for the browser to parse rather than one saved wrongly.
    // Watched, 2026-08-23: `Expected: "2026-05-20" / Received: ""`.
    //
    // The editor is already focused when it mounts (the case above asserts
    // exactly that), and `pressSequentially` focuses too, which leaves the
    // caret where a freshly-focused date input puts it — the first segment.
    //
    // Typed as a person types it: the segments in the order Chrome puts the
    // caret through them, one keystroke at a time.
    await editor.pressSequentially('05202026', { delay: 30 });

    // The whole year is in the box, which is also this test saying out loud
    // what it assumes about the browser: Chrome's date input takes the segments
    // in `MM DD YYYY` order under the `en-US` locale Playwright runs in, so
    // `05202026` is 20 May 2026 and a locale change would fail here rather than
    // somewhere further down.
    await expect(editor).toHaveValue('2026-05-20');

    await page.getByLabel('Name of 010').click();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('20 May');
    await page.reload();
    await expect(page.getByLabel('Earliest start for 010', { exact: true })).toHaveValue('20 May');
  });

  test('a held Ctrl+D arms once and never deletes', async ({ page }) => {
    await seedRows(page, `e2e-keys-${String(Date.now())}-${String(account)}`, 3);

    await page.getByLabel('Name of 020').click();

    // A `down` of a key already down is an auto-repeat: `repeat: true`, and
    // no keyup anywhere in the sequence. That is what the two guards exist
    // for, and it is the shape a real held key has.
    await page.keyboard.down('Control');
    await page.keyboard.down('d');
    for (let repeated = 0; repeated < 6; repeated += 1) {
      await page.keyboard.down('d');
      await page.waitForTimeout(80);
    }
    await page.keyboard.up('d');
    await page.keyboard.up('Control');

    await expect(page.locator('tr[data-armed="true"] [data-number]')).toHaveText('020');
    expect(await numbersOnScreen(page)).toEqual(['010', '020', '030']);
  });
});

/**
 * The shortcuts sheet as a modal, which is a thing only a browser can judge.
 *
 * `keyboard-cheat-sheet.test.tsx` proves the handler: it sees the Tab taken and
 * the focus placed. What it cannot see is the half the UI audit of 2026-08-12
 * found on dev — jsdom performs no default action for Tab, so a sheet with no
 * trap at all passes every unit test about one, and the focus it never moved
 * stays wherever the test put it. R5 #14–#16's fault class, fourth time.
 *
 * The audit's finding was a chain rather than one bug: Tab walked out to the
 * table behind, and Escape — a React handler on the backdrop — then never saw
 * another keystroke, so the dialog could no longer be dismissed from the
 * keyboard at all. Both halves are pressed here, in that order, because the
 * order is the fault.
 */
test.describe('the shortcuts sheet holds the keyboard like a modal', () => {
  /** Opens the sheet from the toolbar control a reader really clicks. */
  async function openCheatSheet(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  }

  /** Whether the focus is on or inside the open dialog. */
  const focusIsInTheSheet = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const here = document.activeElement;
      if (dialog === null) throw new Error('no dialog is open');
      return here instanceof HTMLElement && dialog.contains(here);
    });

  test('Tab never leaves it, and Escape still closes it afterwards', async ({ page }) => {
    // Proof: the Tab branch of the sheet's key handler returned early, this
    // failed on `the focus walked out of the sheet on Tab 2 of 12`. Watched,
    // 2026-08-12.
    //
    // The Escape half of the chain is **not** this test's to prove, and trying
    // it says why: with the listener put back on the backdrop where the audit
    // found it, and the trap left in place, this still passes — the focus
    // never leaves the sheet, so an Escape aimed inside it reaches a React
    // handler on the backdrop by bubbling, exactly as it did before the audit.
    // The fault was the two together, and a Playwright expect that has already
    // failed on Tab 2 never reaches the Escape below. What holds that half is
    // `keyboard-cheat-sheet.test.tsx`'s `closes on Escape from anywhere on the
    // page`, which presses Escape at `document.body` — watched red against the
    // backdrop listener, 2026-08-12. This line stays because the *order* is
    // the reader's experience: Tab, then Escape, then the table.
    await seedRows(page, `e2e-sheet-${String(Date.now())}-${String(account)}`, 3);
    await openCheatSheet(page);

    // Twelve, which is more stops than the sheet has: the trap has to hold on
    // the way round rather than only on the first press off the last stop.
    for (let press = 1; press <= 12; press += 1) {
      await page.keyboard.press('Tab');
      expect(
        await focusIsInTheSheet(page),
        `the focus walked out of the sheet on Tab ${String(press)} of 12`,
      ).toBe(true);
    }
    // And backwards, off the first stop, which is the other end of the trap.
    for (let press = 1; press <= 12; press += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await focusIsInTheSheet(page),
        `Shift+Tab walked out of the sheet on press ${String(press)} of 12`,
      ).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
    // The table behind is still the reader's: the sheet suspended the page's
    // shortcuts while it was up, and it has to give them back.
    await page.getByLabel('Name of 020').click();
    await expect(page.getByLabel('Name of 020')).toBeFocused();
  });

  test('a click on the backdrop closes it, and a click on the sheet does not', async ({ page }) => {
    // The audit reported the backdrop dead on dev. jsdom's own `closes on a
    // click away from it` fires a click straight at the backdrop node, which
    // is not the thing a pointer does: a real click is a mousedown and a
    // mouseup at a **coordinate**, and what is under that coordinate is a
    // question about layout. This presses the corner of the window, which is
    // backdrop on any viewport the sheet is centred in.
    //
    // Proof: `event.target === event.currentTarget` inverted, this failed on
    // `expect(locator).toBeVisible() failed … element(s) not found` — the
    // sheet closed under a click on itself. Watched, 2026-08-12.
    await seedRows(page, `e2e-sheet-away-${String(Date.now())}-${String(account)}`, 3);
    await openCheatSheet(page);

    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const panel = await sheet.boundingBox();
    expect(panel, 'the open sheet has no box').not.toBeNull();
    if (panel === null) return;

    // A click inside the sheet leaves it up, or the check below is about a
    // dialog that closes on every click anywhere.
    await page.mouse.click(Math.round(panel.x + panel.width / 2), Math.round(panel.y + 8));
    await expect(sheet).toBeVisible();

    // Eight pixels in from the top-left corner of the window: outside the
    // centred panel at this viewport, and inside the backdrop, which is
    // `fixed inset-0`.
    await page.mouse.click(8, 8);
    await expect(sheet).toBeHidden();
  });
});
