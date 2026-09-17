import { readFile } from 'node:fs/promises';

import {
  type Download,
  expect,
  type Locator,
  type Page,
  type Response,
  test,
} from '@playwright/test';

import { createProject } from './create-project';

const FIRST_PROJECT_DAY = '2030-01-01';
const WORK_ITEM_DEADLINE = '2030-01-07';
const MOVED_PROJECT_DAY = '2030-02-01';
const DEADLINE_COLUMN = 'Work item deadline';
const UNREACHABLE_COLUMN = 'Work item deadline unreachable';
// The shipped 390x844 layout leaves 347px of this card visible. One complete
// 44px tap target is the named regression floor, not the current-layout pin.
const PHONE_CARD_VISIBLE_FLOOR_PX = 44;
// Deliberately copied instead of imported from deadline-impossible.ts: the export test must
// pin the shipped words independently, or changing producer and oracle together stays green.
const UNREACHABLE_CELL = "before the project's first working day";

test.use({ viewport: { width: 390, height: 844 } });

/** Makes one dated work item through the same controls this suite exercises. */
async function seedDatedWorkItem(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  await createProject(page, 'Deadline browser evidence');
  await page.getByRole('button', { name: 'Plan actions' }).click();
  const actions = page.getByRole('dialog', { name: 'Plan actions' });
  await expect(actions).toBeVisible();
  const projectStart = actions.getByLabel('Project start date');
  const savedProjectStart = savedProjectStartDate(page);
  await projectStart.fill(FIRST_PROJECT_DAY);
  await savedProjectStart;
  await projectStart.blur();
  await actions.getByRole('button', { name: 'Add work item' }).click();
  await expect(page.getByLabel('Name of 010')).toBeVisible();
  await page.getByRole('button', { name: 'Plan actions' }).click();
  await page
    .getByRole('dialog', { name: 'Plan actions' })
    .getByRole('button', {
      name: 'Add work item',
    })
    .click();
  await expect(page.getByLabel('Name of 020')).toBeVisible();
}

/** The work-item id owned by one numbered card. */
async function workItemIdFor(page: Page, number: string): Promise<string> {
  const workItemId = await page
    .getByRole('button', { name: `Work item deadline for ${number}` })
    .evaluate((control) => control.closest('[data-card]')?.getAttribute('data-card'));
  if (workItemId === null || workItemId === undefined)
    throw new Error(`the deadline control for ${number} has no work-item card`);
  return workItemId;
}

/** Refuses to let a missing requested card satisfy one of its own absence checks. */
async function expectCardPresent(card: Locator): Promise<void> {
  // Proof: removing only the requested card after reload left the other card
  // present and failed here on `Expected: 1, Received: 0`. Watched in Chromium
  // at 390x844 on h2puni, 2026-09-13.
  await expect(card).toHaveCount(1);
}

/** A positive-area browser box or a failure naming the surface that vanished. */
async function renderedBox(
  surface: Locator,
  name: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await surface.boundingBox();
  if (box === null) throw new Error(`${name} has no browser box`);
  expect(box.width, `${name} has no rendered width`).toBeGreaterThan(0);
  expect(box.height, `${name} has no rendered height`).toBeGreaterThan(0);
  return box;
}

/** Opens the card's bottom editor and returns the dialog that owns Save and Clear. */
async function openDeadlineEditor(page: Page, number = '010'): Promise<Locator> {
  await page.getByRole('button', { name: `Work item deadline for ${number}` }).click();
  const editor = page.getByRole('dialog', {
    name: new RegExp(`Work item deadline for ${number}`),
  });
  await expect(editor).toBeVisible();
  return editor;
}

/** Saves one deadline through the phone sheet, with no direct API shortcut. */
async function saveDeadline(page: Page, number: string, day: string): Promise<void> {
  const workItemId = await workItemIdFor(page, number);
  const card = page.locator(`[data-card="${workItemId}"]`);
  const editor = await openDeadlineEditor(page, number);
  await editor.getByLabel(`Work item deadline for ${number}`).fill(day);
  const saved = savedWorkItemDeadline(page, workItemId);
  await editor.getByRole('button', { name: 'Save' }).click();
  await saved;
  await expect(editor).toBeHidden();
  // Proof: removing this row's mark after Save while injecting a visible mark
  // on the other numbered card failed here on `element(s) not found`; the old
  // page-global check passed. Watched in Chromium on h2puni, 2026-09-13.
  await expect(card.locator('[data-card-deadline]')).toBeVisible();
}

/** The command response that makes a work-item deadline durable before navigation. */
function savedWorkItemDeadline(page: Page, workItemId: string): Promise<Response> {
  // Proof: suffixing the requested workItemId with `-wrong-row` left the real
  // deadline response unmatched and failed on `page.waitForResponse: Timeout
  // 1000ms exceeded`; the negative probe temporarily shortened the helper's
  // unbounded default (normally limited by the test timeout). Watched on
  // h2puni, 2026-09-13.
  return page.waitForResponse((response) => {
    const request = response.request();
    const body = request.postData() ?? '';
    return (
      request.method() === 'POST' &&
      response.url().includes('/commands') &&
      body.includes('"kind":"patchWorkItem"') &&
      body.includes(`"workItemId":"${workItemId}"`) &&
      body.includes('"deadline":')
    );
  });
}

/** The project PATCH that makes a start-date edit durable before the next gesture. */
function savedProjectStartDate(page: Page): Promise<Response> {
  // Proof: changing this endpoint to `/api/never/` made seedDatedWorkItem fail
  // here on `page.waitForResponse: Timeout 1000ms exceeded`, before Add work
  // item; the negative probe temporarily shortened the helper's timeout from
  // its unbounded default (normally limited by the test timeout). Watched on
  // h2puni, 2026-09-13.
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && /\/api\/projects\/[^/]+$/.test(response.url()),
  );
}

/** Moves day zero through the phone's only route to the project-start control. */
async function moveProjectStart(page: Page, day: string): Promise<void> {
  await page.getByRole('button', { name: 'Plan actions' }).click();
  const actions = page.getByRole('dialog', { name: 'Plan actions' });
  const projectStart = actions.getByLabel('Project start date');
  const saved = savedProjectStartDate(page);
  await projectStart.fill(day);
  await saved;
  await projectStart.blur();
  await page.keyboard.press('Escape');
  await expect(actions).toBeHidden();
}

/** Downloads from the real Export menu and reads the bytes Chromium saved. */
async function downloadedText(page: Page, action: string): Promise<string> {
  const exportMenu = page.locator('[data-export]');
  if ((await exportMenu.getAttribute('open')) === null) await exportMenu.locator('summary').click();
  const saving = page.waitForEvent('download');
  await page.getByRole('button', { name: action, exact: true }).click();
  const download: Download = await saving;
  return readFile(await download.path(), 'utf8');
}

/** RFC 4180 records, preserving quoted CRLF inside a field. */
function csvRecords(csv: string): string[] {
  const records: string[] = [];
  let record = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      record += character;
      if (quoted && csv[index + 1] === '"') {
        record += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === '\r' && csv[index + 1] === '\n' && !quoted) {
      records.push(record);
      record = '';
      index += 1;
    } else record += character;
  }
  if (quoted) throw new Error('downloaded CSV has an unterminated quoted record');
  if (record !== '') records.push(record);
  return records;
}

/**
 * RFC 4180 fields from one complete record.
 *
 * This returns the serialized spreadsheet guard apostrophe unchanged. The fields this suite
 * compares start with letters or digits, never `=`, `+`, `-`, `@`, tab or CR; a fixture that
 * adds one of those leaders must expect the writer's protective apostrophe explicitly.
 */
function csvFields(record: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('downloaded CSV has an unterminated quoted field');
  fields.push(field);
  return fields;
}

/** The fields from one Markdown table line, excluding its framing pipes. */
function markdownFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === '\\' && line[index + 1] === '|') {
      field += '|';
      index += 1;
    } else if (character === '|') {
      fields.push(field.trim());
      field = '';
    } else field += character;
  }
  fields.push(field.trim());
  return fields;
}

/** Pins both deadline columns, their neighbours, and their corresponding row values. */
function expectDeadlineColumns(headers: string[], row: string[]): void {
  const deadline = headers.indexOf(DEADLINE_COLUMN);
  expect(deadline, `${DEADLINE_COLUMN} is absent`).toBeGreaterThan(1);
  // Proof: renaming the shipped unreachable header to `Unreachable` made the
  // CSV download fail here with that exact fourth field. Watched 2026-09-09.
  // `Status` follows since `work-item-status-and-facts`: the row's status and
  // its two facts sit between the two constraints and the computed dates, in
  // the export as in the table. CI watched this pin fail on `Starts` first.
  expect(headers.slice(deadline - 2, deadline + 3)).toEqual([
    'Not before',
    'Not before because',
    DEADLINE_COLUMN,
    UNREACHABLE_COLUMN,
    'Status',
  ]);
  expect(row[deadline]).toBe(WORK_ITEM_DEADLINE);
  expect(row[deadline + 1]).toBe(UNREACHABLE_CELL);
}

test.beforeEach(async ({ page }) => {
  await seedDatedWorkItem(page);
});

test('the phone deadline sheet leaves its card visible and drives Save and Clear', async ({
  page,
}) => {
  const cardId = await workItemIdFor(page, '020');
  const card = page.locator(`[data-card="${cardId}"]`);
  // Keep the low card at the viewport edge and fire the button's real click
  // without Playwright's own pre-click scrolling. The sheet guard, not the
  // test driver, must make room for the field after the portal appears.
  const trigger = card.locator('[data-card-deadline-field]');
  await trigger.evaluate((control) => {
    if (!(control instanceof HTMLButtonElement))
      throw new Error('deadline trigger is not a button');
    control.scrollIntoView({ block: 'end' });
    control.click();
  });
  const editor = page.getByRole('dialog', { name: /Work item deadline for 020/ });
  await expect(editor).toBeVisible();
  // Proof: replacing useTriggerAboveSheet with an inert ref left this field
  // 285px under the fixed bottom sheet and this poll failed. Watched in real
  // Chromium at 390x844 on h2puni, 2026-09-09.
  await expect
    .poll(async () => {
      const triggerBox = await renderedBox(trigger, 'the edited deadline control');
      const currentEditorBox = await renderedBox(editor, 'the deadline sheet');
      return triggerBox.y + triggerBox.height - currentEditorBox.y;
    })
    .toBeLessThan(0);
  await expect
    .poll(async () => (await renderedBox(trigger, 'the edited deadline control')).y, {
      message: 'the edited deadline control moved above the viewport',
    })
    // Proof: translating the trigger 1000px upward failed on `Expected: >= 0,
    // Received: -521`. Watched in Chromium at 390x844 on h2puni, 2026-09-13.
    .toBeGreaterThanOrEqual(0);
  // One passing sample is the invariant here, not a second test-owned stability
  // window: useTriggerAboveSheet applies only after the sheet rect is identical
  // on two frames, the bottom sheet has no open animation, and the preceding
  // overlap poll observes that settled placement.
  await expect
    .poll(
      async () => {
        const currentCardBox = await renderedBox(card, 'the edited card');
        const currentEditorBox = await renderedBox(editor, 'the deadline sheet');
        return (
          Math.min(currentCardBox.y + currentCardBox.height, currentEditorBox.y) -
          Math.max(currentCardBox.y, 0)
        );
      },
      {
        message:
          `less than the ${String(PHONE_CARD_VISIBLE_FLOOR_PX)}px tap-target floor remains ` +
          'visible above the sheet (347px shipped at 390x844)',
      },
    )
    // Proof: injecting `height: 1px` on the border-box card clamped it to its
    // 24px padding plus 2px border and failed on `Expected: >= 44, Received:
    // 26`. Watched in Chromium at 390x844 on h2puni, 2026-09-13.
    .toBeGreaterThanOrEqual(PHONE_CARD_VISIBLE_FLOOR_PX);

  await editor.getByLabel('Work item deadline for 020').fill(WORK_ITEM_DEADLINE);
  const saved = savedWorkItemDeadline(page, cardId);
  await editor.getByRole('button', { name: 'Save' }).click();
  await saved;
  await expect(card.locator('[data-card-deadline]')).toBeVisible();
  await page.reload();
  await expectCardPresent(card);
  await expect(card.locator('[data-card-deadline]')).toBeVisible();

  const reopened = await openDeadlineEditor(page, '020');
  const cleared = savedWorkItemDeadline(page, cardId);
  await reopened.getByRole('button', { name: 'Clear' }).click();
  await cleared;
  await expectCardPresent(card);
  await expect(card.locator('[data-card-deadline]')).toHaveCount(0);
  await page.reload();
  await expectCardPresent(card);
  await expect(card.locator('[data-card-deadline]')).toHaveCount(0);
});

test('renders impossible marks on both faces and downloads both deadline columns', async ({
  page,
}) => {
  await saveDeadline(page, '010', WORK_ITEM_DEADLINE);
  await moveProjectStart(page, MOVED_PROJECT_DAY);
  await page.reload();

  const impossibleName = "Work item deadline for 010 falls before the project's first working day";
  const cardMark = page.getByRole('img', { name: impossibleName });
  // Proof: role="presentation" on this card mark made this accessible-role
  // lookup fail in Chromium. Watched on h2puni, 2026-09-09.
  await expect(cardMark).toHaveAttribute('data-card-deadline-impossible');
  await renderedBox(cardMark, 'the card impossible-date mark');
  const cardMarkId = await cardMark.getAttribute('id');
  if (cardMarkId === null) throw new Error('the card impossible-date mark has no id');
  // Proof: removing aria-describedby from this trigger failed on the missing
  // attribute (`Expected: card-deadline-impossible-…, Received: ""`). Watched
  // in Chromium on h2puni, 2026-09-13.
  await expect(page.getByRole('button', { name: 'Work item deadline for 010' })).toHaveAttribute(
    'aria-describedby',
    cardMarkId,
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Deadline', exact: true }).check();
  await expect(page.locator('thead th[data-column="deadline"]')).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
  const tableMark = page.getByRole('img', { name: impossibleName });
  // Proof: role="presentation" on the table's independent mark made this
  // lookup fail after the card assertion passed. Watched on h2puni, 2026-09-09.
  await expect(tableMark).toHaveAttribute('data-deadline-impossible');
  await renderedBox(tableMark, 'the table impossible-date mark');

  const csv = (await downloadedText(page, 'Download CSV')).replace(/^\uFEFF/, '');
  const parsedCsv = csvRecords(csv).map(csvFields);
  const csvHeaders = parsedCsv.find((record) => record[0] === 'Number');
  const csvRow = parsedCsv.find((record) => record[0] === '010');
  if (csvHeaders === undefined || csvRow === undefined)
    throw new Error('downloaded CSV has no plan header or row 010');
  expectDeadlineColumns(csvHeaders, csvRow);

  const markdown = await downloadedText(page, 'Download as Markdown');
  const markdownLines = markdown.split('\n');
  const headerIndex = markdownLines.findIndex((line) => line.startsWith('| Number |'));
  if (headerIndex < 0) throw new Error('downloaded Markdown has no plan table header');
  const markdownHeaders = markdownFields(markdownLines[headerIndex] ?? '');
  const markdownRowLine = markdownLines
    .slice(headerIndex + 2)
    .find((line) => line.startsWith('| 010 |'));
  if (markdownRowLine === undefined) throw new Error('downloaded Markdown has no row 010');
  expectDeadlineColumns(markdownHeaders, markdownFields(markdownRowLine));
});
