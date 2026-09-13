import { expect, type Page } from '@playwright/test';
import {
  addStep,
  applyDirectoryCommands,
  applyProjectCommands,
  clientFromShapes,
  createProject,
  getWorkItems,
  listTags,
  type PlanCommandWire,
  readProject,
  type TransportReply,
} from '@wbs/contracts';

const CHUNK_SIZE = 200;

export interface PlanFixtureIdentity {
  run: string;
  worker: number;
  test: string;
}

export interface PlanRecipeRow {
  ref: string;
  name: string;
  afterRef?: string;
  estimates?: Readonly<
    Record<string, { optimistic: number; realistic: number; pessimistic: number }>
  >;
  tagRefs?: readonly string[];
}

export interface PlanRecipe {
  name: string;
  rows: readonly PlanRecipeRow[];
  tags?: readonly { ref: string; name: string }[];
}

export interface SeededPlan {
  projectId: string;
  projectName: string;
  rowIds: Readonly<Record<string, string>>;
  stepIds: Readonly<Record<string, string>>;
  tagIds: Readonly<Record<string, string>>;
}

function fixtureName(name: string, identity: PlanFixtureIdentity): string {
  return `${name} [${identity.run}/w${String(identity.worker)}/${identity.test}]`;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface NormalizedRecipeRow extends Omit<PlanRecipeRow, 'afterRef'> {
  afterRef: string | null;
}

function normalizeRecipeRows(recipe: PlanRecipe): readonly NormalizedRecipeRow[] {
  const rowRefs = new Set<string>();
  for (const row of recipe.rows) {
    // Proof: deleting this refusal made the duplicate-recipe-ref browser case observe a project POST.
    if (rowRefs.has(row.ref)) throw new Error(`duplicate recipe row ref: ${row.ref}`);
    // Proof: removing this refusal made `an unavailable predecessor fails before a write request`
    // observe one project POST before the later unresolved-ref refusal.
    if (row.afterRef !== undefined && !rowRefs.has(row.afterRef))
      throw new Error(`recipe row ${row.ref} follows unavailable ref: ${row.afterRef}`);
    rowRefs.add(row.ref);
  }
  const tagRefs = new Set<string>();
  for (const tag of recipe.tags ?? []) {
    // Proof: removing this refusal made `a duplicate tag ref fails before a write request`
    // observe one project POST before directory identity verification refused.
    if (tagRefs.has(tag.ref)) throw new Error(`duplicate recipe tag ref: ${tag.ref}`);
    tagRefs.add(tag.ref);
  }
  for (const row of recipe.rows) {
    for (const tagRef of row.tagRefs ?? []) {
      // Proof: removing this refusal made `an unknown row tag ref fails before a write request`
      // observe one project POST before the later missing-id refusal.
      if (!tagRefs.has(tagRef)) throw new Error(`unknown recipe tag ref: ${tagRef}`);
    }
  }
  return recipe.rows.map((row, index) => ({
    ...row,
    // Recipe array order is authoritative when a caller omits a predecessor.
    // Proof: defaulting every omission to null reversed the real two-row plan
    // and the 201-row plan across its batch boundary; both exact-id checks failed.
    afterRef: row.afterRef ?? (index === 0 ? null : recipe.rows[index - 1].ref),
  }));
}

function calculateExpectedRowRefs(rows: readonly NormalizedRecipeRow[]): readonly string[] {
  const orderedRefs: string[] = [];
  for (const row of rows) {
    const predecessorIndex = row.afterRef === null ? -1 : orderedRefs.indexOf(row.afterRef);
    if (row.afterRef !== null && predecessorIndex < 0)
      throw new Error(`expected order is missing predecessor: ${row.afterRef}`);
    orderedRefs.splice(predecessorIndex + 1, 0, row.ref);
  }
  return orderedRefs;
}

function pageTransport(page: Page) {
  return async (
    shape: { method: string; path: string },
    input: { params: Record<string, string | undefined>; body: unknown },
  ): Promise<TransportReply> => {
    const path = shape.path
      .split('/')
      .map((segment) =>
        segment.startsWith(':')
          ? encodeURIComponent(input.params[segment.slice(1)] ?? '')
          : segment,
      )
      .join('/');
    return page.evaluate(
      async ({ method, path, body }) => {
        const response = await fetch(path, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const headers = [...response.headers.entries()];
        if (response.status === 204) return { kind: 'empty' as const, status: 204, headers };
        return {
          kind: 'json' as const,
          status: response.status,
          headers,
          body: JSON.parse(await response.text()) as unknown,
        };
      },
      { method: shape.method, path, body: input.body },
    );
  };
}

export function fixtureSuccess<T extends { kind: string; status?: number }>(
  operation: string,
  reply: T,
): Extract<T, { kind: 'success' }> {
  if (reply.kind !== 'success') throw new Error(`${operation} refused: ${JSON.stringify(reply)}`);
  return reply as Extract<T, { kind: 'success' }>;
}

/** Generated-shape client carried through the browser's authenticated same-origin fetch. */
export function fixtureClient(page: Page) {
  return clientFromShapes(
    [
      createProject,
      readProject,
      addStep,
      applyProjectCommands,
      applyDirectoryCommands,
      getWorkItems,
      listTags,
    ] as const,
    pageTransport(page),
  );
}

interface FixtureCommand {
  kind: string;
  ref?: string;
}

interface FixtureCommandResult {
  index: number;
  ref?: string;
  id?: string;
}

const IDENTITY_COMMANDS = new Set(['createTag', 'createWorkItem']);

/** Correlates a successful fixture batch body with its exact submitted command order. */
export function assertCommandResults(
  operation: string,
  commands: readonly FixtureCommand[],
  results: readonly FixtureCommandResult[],
): Record<string, string> {
  if (results.length !== commands.length)
    throw new Error(
      `${operation} returned ${String(results.length)} of ${String(commands.length)} results`,
    );
  const identities: [string, string][] = [];
  for (const [index, command] of commands.entries()) {
    const answer = results[index];
    // Proof: removing this correlation let empty, missing, index999 and
    // duplicate-index authored HTTP200 bodies reach the next write/tree read.
    if (answer.index !== index)
      throw new Error(
        `${operation} result at ${String(index)} has index ${String(answer.index)}, expected ${String(index)}`,
      );
    if (answer.ref !== command.ref)
      throw new Error(
        `${operation} result at ${String(index)} has ref ${String(answer.ref)}, expected ${String(command.ref)}`,
      );
    if (!IDENTITY_COMMANDS.has(command.kind)) continue;
    if (command.ref === undefined)
      throw new Error(`${operation} identity command at ${String(index)} has no submitted ref`);
    if (typeof answer.id !== 'string')
      throw new Error(`${operation} result at ${String(index)} has no id for ${command.ref}`);
    identities.push([command.ref, answer.id]);
  }
  return Object.fromEntries(identities);
}

/** Seeds one independently named plan through validated public HTTP shapes and verifies its stored state. */
export async function seedPlan(
  page: Page,
  recipe: PlanRecipe,
  identity: PlanFixtureIdentity,
): Promise<SeededPlan> {
  const recipeRows = normalizeRecipeRows(recipe);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'local-dev' })).toBeVisible();
  const client = fixtureClient(page);
  const projectName = fixtureName(recipe.name, identity);
  const created = fixtureSuccess(
    'postApiProjects',
    await client.postApiProjects({ body: { name: projectName } }),
  ).body;
  const projectId = created.project.id;
  const read = fixtureSuccess(
    'getApiProjectsById',
    await client.getApiProjectsById({ params: { id: projectId } }),
  ).body;
  const stepIdByName = new Map(read.steps.map((step) => [step.name, step.id]));
  const stepIds = Object.fromEntries(stepIdByName);

  const tags = (recipe.tags ?? []).map((tag) => ({
    kind: 'createTag' as const,
    ref: tag.ref,
    name: fixtureName(tag.name, identity),
  }));
  const tagIds: Record<string, string> = {};
  // Proof: sending all 201 real tag commands together reached be-01 and was
  // refused as too_many_commands at index 200 instead of producing [200, 1].
  for (let start = 0; start < tags.length; start += CHUNK_SIZE) {
    const commands = tags.slice(start, start + CHUNK_SIZE);
    const answer = fixtureSuccess(
      'postApiDirectoryCommands',
      await client.postApiDirectoryCommands({ body: { commands } }),
    );
    Object.assign(
      tagIds,
      assertCommandResults('postApiDirectoryCommands', commands, answer.body.results),
    );
  }

  const storedTags = fixtureSuccess('getApiTags', await client.getApiTags({})).body.tags;
  const storedTagById = new Map(storedTags.map((tag) => [tag.id, tag]));
  for (const tag of tags) {
    const tagId = tagIds[tag.ref];
    // Proof: removing this directory comparison made the swapped-successful-tag-ids
    // case resolve and start its project commands instead of refusing here.
    expect(storedTagById.get(tagId)?.name, `stored tag identity for ${tag.ref}`).toBe(tag.name);
  }

  const rowIdByRef = new Map<string, string>();
  for (let start = 0; start < recipeRows.length; start += CHUNK_SIZE) {
    const rows = recipeRows.slice(start, start + CHUNK_SIZE);
    const localRefs = new Set(rows.map((row) => row.ref));
    const commands: PlanCommandWire[] = rows.map((row) => {
      const { afterRef } = row;
      let placement: { afterId: string | null } | { afterRef: string };
      if (afterRef === null) {
        placement = { afterId: null };
      } else if (localRefs.has(afterRef)) {
        placement = { afterRef };
      } else {
        const afterId = rowIdByRef.get(afterRef);
        if (afterId === undefined)
          throw new Error(`recipe row ${row.ref} follows unresolved ref: ${afterRef}`);
        placement = { afterId };
      }
      return {
        kind: 'createWorkItem',
        ref: row.ref,
        name: row.name,
        parentId: null,
        ...placement,
      };
    });
    const answer = fixtureSuccess(
      'postApiProjectsByIdCommands',
      await client.postApiProjectsByIdCommands({ params: { id: projectId }, body: { commands } }),
    );
    for (const [ref, id] of Object.entries(
      assertCommandResults('postApiProjectsByIdCommands', commands, answer.body.results),
    ))
      rowIdByRef.set(ref, id);
  }

  const rowIds = Object.fromEntries(rowIdByRef);

  const authored: PlanCommandWire[] = recipeRows.flatMap((row) => {
    const workItemId = rowIdByRef.get(row.ref);
    if (workItemId === undefined) throw new Error(`seeded row has no id: ${row.ref}`);
    const estimates: PlanCommandWire[] = Object.entries(row.estimates ?? {}).map(
      ([stepName, days]) => {
        const stepId = stepIdByName.get(stepName);
        if (stepId === undefined) throw new Error(`recipe names unknown step: ${stepName}`);
        return { kind: 'setEstimate', workItemId, stepId, days };
      },
    );
    const tagIdsForRow = (row.tagRefs ?? []).map((ref) => {
      const id = Object.hasOwn(tagIds, ref) ? tagIds[ref] : undefined;
      if (id === undefined) throw new Error(`seeded tag has no id: ${ref}`);
      return id;
    });
    return tagIdsForRow.length === 0
      ? estimates
      : [...estimates, { kind: 'patchWorkItem', workItemId, patch: { tagIds: tagIdsForRow } }];
  });
  for (let start = 0; start < authored.length; start += CHUNK_SIZE) {
    const commands = authored.slice(start, start + CHUNK_SIZE);
    const answer = fixtureSuccess(
      'postApiProjectsByIdCommands',
      await client.postApiProjectsByIdCommands({ params: { id: projectId }, body: { commands } }),
    );
    assertCommandResults('postApiProjectsByIdCommands', commands, answer.body.results);
  }

  const tree = fixtureSuccess(
    'getApiProjectsByIdWork-items',
    await client['getApiProjectsByIdWork-items']({ params: { id: projectId } }),
  ).body;
  // Proof: replacing this placement calculation with recipe array order made the
  // explicit sibling case expect [a,b,c] from the stored [a,c,b].
  expect(tree.workItems.map((row) => row.id)).toEqual(
    calculateExpectedRowRefs(recipeRows).map((ref) => rowIds[ref]),
  );
  for (const expected of recipeRows) {
    const stored = tree.workItems.find((row) => row.id === rowIds[expected.ref]);
    if (stored === undefined) throw new Error(`stored tree is missing row ${expected.ref}`);
    expect(stored.name, `stored name for ${expected.ref}`).toBe(expected.name);
    for (const [stepName, days] of Object.entries(expected.estimates ?? {})) {
      const stepId = stepIdByName.get(stepName);
      if (stepId === undefined) throw new Error(`verified recipe names unknown step: ${stepName}`);
      expect(stored.estimates[stepId], `stored estimate for ${expected.ref}/${stepName}`).toEqual(
        days,
      );
    }
    expect([...stored.tagIds].sort(), `stored tag ids for ${expected.ref}`).toEqual(
      (expected.tagRefs ?? []).map((ref) => tagIds[ref]).sort(),
    );
  }
  return { projectId, projectName, rowIds, stepIds, tagIds };
}

/** Opens a seeded plan through the real picker-facing selected-project state. */
export async function openSeededPlan(page: Page, seeded: SeededPlan): Promise<void> {
  await page.goto('/');
  const picker = page.getByRole('combobox', { name: 'Project' });
  await picker.click();
  await expect(page.getByRole('listbox', { name: 'Projects' })).toBeVisible();
  await picker.fill(seeded.projectName);
  await page.getByRole('option', { name: new RegExp(`^${escaped(seeded.projectName)}`) }).click();
  await expect(picker).toHaveValue(seeded.projectName);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('wbs.project')))
    .toBe(seeded.projectId);
}
