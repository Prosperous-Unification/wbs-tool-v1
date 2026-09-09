import { readFile } from 'node:fs/promises';

import { type Download, expect, type Locator, type Page, test } from '@playwright/test';

import { createProject } from './create-project';

const FIRST_PROJECT_DAY = '2030-01-01';
const WORK_ITEM_DEADLINE = '2030-01-07';
const MOVED_PROJECT_DAY = '2030-02-01';
const DEADLINE_COLUMN = 'Work item deadline';
const UNREACHABLE_COLUMN = 'Work item deadline unreachable';
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
  await projectStart.fill(FIRST_PROJECT_DAY);
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
async function saveDeadline(page: Page, day: string): Promise<void> {
  const editor = await openDeadlineEditor(page);
  await editor.getByLabel('Work item deadline for 010').fill(day);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('[data-card-deadline]')).toBeVisible();
}

/** Moves day zero through the phone's only route to the project-start control. */
async function moveProjectStart(page: Page, day: string): Promise<void> {
  await page.getByRole('button', { name: 'Plan actions' }).click();
  const actions = page.getByRole('dialog', { name: 'Plan actions' });
  const projectStart = actions.getByLabel('Project start date');
  await projectStart.fill(day);
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

/** RFC 4180's quoting rules, enough to identify exact fields rather than substrings. */
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
  return line
    .split('|')
    .slice(1, -1)
    .map((field) => field.trim());
}

/** Pins both deadline columns, their neighbours, and their corresponding row values. */
function expectDeadlineColumns(headers: string[], row: string[]): void {
  const deadline = headers.indexOf(DEADLINE_COLUMN);
  expect(deadline, `${DEADLINE_COLUMN} is absent`).toBeGreaterThan(1);
  // Proof: renaming the shipped unreachable header to `Unreachable` made the
  // CSV download fail here with that exact fourth field. Watched 2026-09-09.
  expect(headers.slice(deadline - 2, deadline + 3)).toEqual([
    'Not before',
    'Not before because',
    DEADLINE_COLUMN,
    UNREACHABLE_COLUMN,
    'Starts',
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
  const accessibleTrigger = page.getByRole('button', { name: 'Work item deadline for 020' });
  const cardId = await accessibleTrigger.evaluate((control) =>
    control.closest('[data-card]')?.getAttribute('data-card'),
  );
  if (cardId === null || cardId === undefined)
    throw new Error('the deadline control has no work-item card');
  const card = page.locator(`[data-card="${cardId}"]`);
  // Keep the low card at the viewport edge and fire the button's real click
  // without Playwright's own pre-click scrolling. The sheet guard, not the
  // test driver, must make room for the field after the portal appears.
  const trigger = card.locator('[data-card-deadline-field]');
  await trigger.evaluate((control) => {
    control.scrollIntoView({ block: 'end' });
    if (!(control instanceof HTMLButtonElement))
      throw new Error('deadline trigger is not a button');
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
  const cardBox = await renderedBox(card, 'the edited card');
  const editorBox = await renderedBox(editor, 'the deadline sheet');
  expect(
    Math.min(cardBox.y + cardBox.height, editorBox.y) - Math.max(cardBox.y, 0),
    'none of the edited card remains visible above the sheet',
  ).toBeGreaterThan(0);

  await editor.getByLabel('Work item deadline for 020').fill(WORK_ITEM_DEADLINE);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(card.locator('[data-card-deadline]')).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-card="${cardId}"] [data-card-deadline]`)).toBeVisible();

  const reopened = await openDeadlineEditor(page, '020');
  await reopened.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator(`[data-card="${cardId}"] [data-card-deadline]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-card="${cardId}"] [data-card-deadline]`)).toHaveCount(0);
});

test('renders impossible marks on both faces and downloads both deadline columns', async ({
  page,
}) => {
  await saveDeadline(page, WORK_ITEM_DEADLINE);
  await moveProjectStart(page, MOVED_PROJECT_DAY);
  await page.reload();

  const impossibleName = "Work item deadline for 010 falls before the project's first working day";
  const cardMark = page.getByRole('img', { name: impossibleName });
  // Proof: role="presentation" on this card mark made this accessible-role
  // lookup fail in Chromium. Watched on h2puni, 2026-09-09.
  await expect(cardMark).toHaveAttribute('data-card-deadline-impossible');
  await renderedBox(cardMark, 'the card impossible-date mark');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByText('Columns', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Deadline' }).check();
  await expect(page.locator('thead th[data-column="deadline"]')).toHaveCount(1);
  await page.getByText('Columns', { exact: true }).click();
  const tableMark = page.getByRole('img', { name: impossibleName });
  // Proof: role="presentation" on the table's independent mark made this
  // lookup fail after the card assertion passed. Watched on h2puni, 2026-09-09.
  await expect(tableMark).toHaveAttribute('data-deadline-impossible');
  await renderedBox(tableMark, 'the table impossible-date mark');

  const csv = (await downloadedText(page, 'Download CSV')).replace(/^\uFEFF/, '');
  const csvRecords = csv.split('\r\n').map(csvFields);
  const csvHeaders = csvRecords.find((record) => record[0] === 'Number');
  const csvRow = csvRecords.find((record) => record[0] === '010');
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
