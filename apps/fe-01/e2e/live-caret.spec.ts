import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

/**
 * The caret, while somebody else edits the same plan — task 3.3 of
 * `keep-focus-while-others-edit`.
 *
 * **jsdom cannot be the oracle for any of this, and the change's own
 * `verify.md` said so before this file existed.** Three things here are a
 * browser's and nothing else's:
 *
 * - **There is no caret in jsdom to move.** `wbs-table.test.tsx` asserts
 *   `document.activeElement` and the box's text, which is what it can see; the
 *   claim the change is actually about — the insertion point stays at character
 *   `n` of a half-typed word, and a backward selection keeps its anchor and its
 *   direction — needs a text control a real engine lays out and a real
 *   `selectionDirection` to read off it.
 * - **The peer is a fake there.** The unit suite delivers "another client's
 *   edit" by re-rendering with a new prop. Here it is a second browser context
 *   with its own React app and its own gateway socket, and the edit travels
 *   `POST …/commands` → be-01 → gw-01 → the other session's refetch. What
 *   `tasks.md` 3.2 proved on dev is that the frame arrives; what nobody had
 *   watched is where the caret is a moment later.
 * - **Assigning `value` to a focused `<textarea>` is a browser behaviour.**
 *   The HTML spec moves the text entry cursor to the end of the new value and
 *   drops the selection with it, which is precisely the damage rule 2 of
 *   {@link LiveField} exists to prevent — and precisely what a DOM with no
 *   text entry cursor cannot report.
 *
 * **The window the fault lives in is opened deliberately.** The peer renames
 * the row being typed in *first* and a bystander row *second*, and this session
 * waits for the bystander's new name to appear before it reads the caret. That
 * name can only come from a refetch issued after both writes landed, so the
 * withheld value has certainly reached the focused cell by then. Reading the
 * caret straight after the peer's keystrokes would be satisfied by its first
 * sample, before the answer it is about — `estimate-triple-visible`'s whole
 * family of five, in `AGENTS.md`.
 *
 * **What each assertion's fault is, and where it was watched.** The comparison
 * below is one `toEqual` over one snapshot, so a single diff names every field
 * that moved, and the two faults reach different fields:
 *
 * - the caret, the selection and the half-typed text: rule 2 of `sync` in
 *   `live-editing.ts`, deleted — see the `Proof:` at the assertion.
 * - the focus and the node's identity: a value-bearing `key` back on the box in
 *   `cell-input.tsx`, which is the fault the change removed from
 *   `wbs-table.tsx` — see the second `Proof:` there.
 */

/** The name the row has on the server when the typing starts. */
const SEEDED = 'Strip the wiring';

/**
 * What is in the box, unsent, when the peer's edit arrives.
 *
 * Deliberately unfinished — `the she` is mid-word — because that is what a
 * half-typed value is, and because the caret is then somewhere no `End` key
 * would have put it.
 */
const HALF_TYPED = 'Strip the wiring in the she';

/** What the peer renames the typed-in row to, which this session must not show yet. */
const RENAMED = 'Rewire the shed';

/** The bystander row's name before and after the peer touches it. */
const BYSTANDER_WAS = 'Sand the floor';
const BYSTANDER_NOW = 'Sand the floor twice';

/** How many characters of the selection the peer's edit must not eat. */
const SELECTED = 4;

/**
 * An expando this test puts on the box it is watching, to answer "is this the
 * same element".
 *
 * A property rather than an attribute, and never a `data-*`: React sets and
 * removes attributes on the nodes it keeps, so an attribute is a claim about
 * React's reconciler as much as about the node. A property React has never
 * heard of survives every re-render of the box that is kept and exists on no
 * box that was mounted in its place.
 */
const WITNESS = '__caretWitnessOfLiveCaretSpec';

/** What the box being watched holds, where its caret is, and whether it is still itself. */
interface BoxState {
  value: string;
  start: number | null;
  end: number | null;
  direction: string | null;
  focused: boolean;
  sameElement: boolean;
}

/** Signs in through the fixed local identity, on a page with no project open. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
}

/**
 * Opens an existing project by name, the way a second person would.
 *
 * The selected project is deliberately not in the URL and not remembered across
 * contexts (`project-page.tsx`), so the peer has to pick it off the bar. The
 * picker is clicked from the heading first for `project-picker.spec.ts`'s
 * reason: the list opens on the box taking the focus, and a box that already
 * has it fires no `focus` at all.
 */
async function openProject(page: Page, name: string): Promise<void> {
  await page.getByRole('heading', { name: 'WBS tool v2' }).click();
  const picker = page.getByRole('combobox', { name: 'Project' });
  await picker.click();
  await expect(page.getByRole('listbox', { name: 'Projects' })).toBeVisible();
  await page
    .getByRole('option', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) })
    .click();
  await expect(picker).toHaveValue(name);
}

/** Types `text` into a Name cell and leaves it, which is what saves it. */
async function writeInto(cell: Locator, text: string): Promise<void> {
  await cell.fill(text);
  await cell.blur();
}

/** Everything about the watched box that a peer's edit could disturb, read in one go. */
function readBox(cell: Locator): Promise<BoxState> {
  return cell.evaluate((node, witness) => {
    if (!(node instanceof HTMLTextAreaElement)) throw new Error('the Name cell is not a textarea');
    return {
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
      direction: node.selectionDirection,
      focused: node === document.activeElement,
      // `in` on the node itself: a box React mounted in place of this one is a
      // different object and carries nothing this test put on the old one.
      sameElement: witness in node,
    };
  }, WITNESS);
}

let peerContext: BrowserContext | undefined;

test.afterEach(async () => {
  await peerContext?.close();
  peerContext = undefined;
});

test.describe('a caret survives another session’s edit', () => {
  test('their rename of the row being typed in moves neither the caret nor the text', async ({
    browser,
    page,
  }) => {
    const plan = `Keep the caret ${String(Date.now())}`;
    await signIn(page);
    await createProject(page, plan);

    const addRow = page.getByRole('button', { name: 'Add work item' });
    await addRow.click();
    await expect(page.getByLabel('Name of 010')).toBeVisible();
    await addRow.click();
    await expect(page.getByLabel('Name of 020')).toBeVisible();
    await writeInto(page.getByLabel('Name of 010'), SEEDED);
    await writeInto(page.getByLabel('Name of 020'), BYSTANDER_WAS);

    // Explicit rather than inherited: a context made from the `browser` fixture
    // does not take the config's `use` options, so a peer built with
    // `newContext()` alone would have no `baseURL` to `goto('/')` against and a
    // viewport of its own. The origin is read off the page under test so the
    // pair stays on whatever `E2E_PORT_SHIFT` this run was given.
    peerContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1400, height: 900 },
    });
    const peer = await peerContext.newPage();
    await signIn(peer);
    await openProject(peer, plan);
    await expect(peer.getByLabel('Name of 010')).toHaveValue(SEEDED);

    // A real caret, put where a real one goes: the box is focused by a click,
    // its text replaced by typing over a selection, and the caret then walked
    // back into the middle by the arrow key. Nothing here is
    // `setSelectionRange` — a synthetic selection would prove that this test
    // can call a setter.
    const cell = page.getByLabel('Name of 010');
    await cell.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(HALF_TYPED);
    const caretAt = Math.floor(HALF_TYPED.length / 2);
    for (let step = HALF_TYPED.length; step > caretAt; step -= 1) {
      await page.keyboard.press('ArrowLeft');
    }
    // Shift, so the box holds a selection with an anchor and a direction and
    // not only an insertion point: the requirement is "focus, the caret and any
    // selection", and `selectionDirection` is the field a `value` assignment
    // resets to `none` (`cell-input.tsx` records the same fault from the
    // measurement side).
    for (let taken = 0; taken < SELECTED; taken += 1) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await cell.evaluate((node, witness) => {
      (node as unknown as Record<string, boolean>)[witness] = true;
    }, WITNESS);

    const before = await readBox(cell);
    // The starting point is asserted rather than assumed, because everything
    // below is a comparison against it: a caret this test failed to place would
    // otherwise make the comparison a tautology about `{start: 27, end: 27}`,
    // which is the very "at the end" case task 3.3 rules out.
    expect(before, 'the caret was not put in the middle of a half-typed name').toEqual({
      value: HALF_TYPED,
      start: caretAt - SELECTED,
      end: caretAt,
      direction: 'backward',
      focused: true,
      sameElement: true,
    });

    // The typed-in row first and the bystander second, and the first one is
    // waited for: two commands posted back to back could otherwise reach be-01
    // in either order, and then the bystander's arrival below would say nothing
    // about the rename this test is actually about.
    const renameLanded = peer.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/commands') &&
        response.ok(),
    );
    await writeInto(peer.getByLabel('Name of 010'), RENAMED);
    await renameLanded;
    await writeInto(peer.getByLabel('Name of 020'), BYSTANDER_NOW);

    // The window. This name exists nowhere in this session — it was never typed
    // here — so the only thing that can put it on screen is a refetch, and a
    // refetch that carries it was issued after the rename above had landed.
    await expect(
      page.getByLabel('Name of 020'),
      'the peer’s edit never reached this session, so nothing below is about anything',
    ).toHaveValue(BYSTANDER_NOW);

    const after = await readBox(cell);
    // One comparison over one snapshot, so the diff names every field the
    // arriving edit disturbed.
    //
    // Proof, two faults, both injected and watched in Chromium on 2026-08-30,
    // and both quoted from the run rather than from the expectation:
    //
    // - `live-editing.ts`'s rule 2 — `if (this.typedHere && node ===
    //   document.activeElement) return;` — deleted from `sync`, so the peer's
    //   name is assigned to the box that has the focus. Four fields moved:
    //   `- "direction": "backward" / + "direction": "none"`, `- "end": 13 /
    //   + "end": 15`, `- "start": 9 / + "start": 15`, `- "value": "Strip the
    //   wiring in the she" / + "value": "Rewire the shed"`. `focused` and
    //   `sameElement` stayed true — the box was never replaced, its text and
    //   its caret were simply taken: 15 is the end of somebody else's name.
    // - `key={value}` put on `cell-input.tsx`'s `<textarea>`, the value-bearing
    //   key this change took off `wbs-table.tsx` wearing the child's hat. Six
    //   fields moved: the four above, with `+ "start": 0 / + "end": 0` this
    //   time rather than the end of the text, plus `- "focused": true /
    //   + "focused": false` and `- "sameElement": true / + "sameElement":
    //   false` — a box React mounted in place of the watched one, at rest, with
    //   the focus gone off it altogether.
    expect(after, 'the peer’s edit disturbed the box being typed in').toEqual(before);
  });

  test('a peer marker appears without disturbing the editor', async ({ browser, page }) => {
    const plan = `Keep the caret through a marker ${String(Date.now())}`;
    await signIn(page);
    await createProject(page, plan);

    const start = page.getByLabel('Project start date');
    await start.fill('2026-09-07');
    await start.blur();
    await expect(start).toHaveValue('2026-09-07');

    await page.getByRole('button', { name: 'Add work item' }).click();
    const cell = page.getByLabel('Name of 010');
    await expect(cell).toBeVisible();
    await writeInto(cell, SEEDED);
    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('[data-gantt-chart]')).toBeVisible();

    peerContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1400, height: 900 },
    });
    const peer = await peerContext.newPage();
    await signIn(peer);
    await openProject(peer, plan);
    await peer.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(peer.locator('[data-gantt-chart]')).toBeVisible();

    await cell.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(HALF_TYPED);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await cell.evaluate((node, witness) => {
      (node as unknown as Record<string, boolean>)[witness] = true;
    }, WITNESS);
    const before = await readBox(cell);
    expect(before.focused, 'the editor did not hold focus before the peer marker').toBe(true);
    expect(before.sameElement, 'the editor witness was not installed').toBe(true);

    await peer.locator('[data-axis-day="3"]').click();
    const composer = peer.getByRole('dialog', { name: /^New calendar marker on / });
    await expect(composer).toBeVisible();
    await composer.getByLabel('Marker name').fill('Peer checkpoint');
    const created = peer.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/calendar-markers') &&
        response.ok(),
    );
    await composer.getByRole('button', { name: /^Save the new calendar marker on / }).click();
    await created;

    // Wait on output only the peer's marker refresh can install, so the editor
    // comparison below is made after the invalidation has reached this page.
    const marker = page.locator('[data-marker-chip]', { hasText: 'Peer checkpoint' });
    // Proof: routing `calendar_markers_changed` to tree instead of markers in
    // `resourcesFor` failed here after 30s: expected count 1, received 0.
    await expect(marker, 'the peer marker never reached this session').toHaveCount(1);

    const after = await readBox(cell);
    expect(after, 'the peer marker disturbed the box being typed in').toEqual(before);
  });
});
