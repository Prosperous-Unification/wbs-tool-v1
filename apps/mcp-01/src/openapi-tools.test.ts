import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import type { DerivedTool } from './openapi-tools';
import { EXCLUDED_PATHS, isExcluded, readDocument, toolsFromDocument } from './openapi-tools';

interface FixtureBodySchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}
interface FixtureOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: { name?: string; in?: string; required?: boolean; schema?: unknown }[];
  requestBody?: {
    description?: string;
    content?: Record<string, { schema?: FixtureBodySchema } | undefined>;
  };
}
interface FixtureDocument {
  paths: Record<string, Record<string, FixtureOperation | undefined> | undefined>;
}

/**
 * A fresh miniature of the real document each call, so a test that mutates it
 * cannot reach the next test. It carries one member of each exclusion class,
 * because the exclusion list is checked *against* the document.
 */
const fixture = (): FixtureDocument => ({
  paths: {
    '/health': { get: { operationId: 'getHealth' } },
    '/metrics': { get: { operationId: 'getMetrics' } },
    '/api/smoke/echo': { post: { operationId: 'postApiSmokeEcho' } },
    '/api/auth/login': { post: { operationId: 'postApiAuthLogin' } },
    '/internal/forward': { post: { operationId: 'postInternalForward' } },
    '/api/projects/': {
      get: {
        operationId: 'getApiProjects',
        parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
      },
    },
    '/api/projects/{id}': {
      get: {
        operationId: 'getApiProjectsById',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/api/projects/{id}/bands/{stepId}': {
      put: {
        operationId: 'putBand',
        summary: 'Set a band',
        description: 'Bands are derived downstream.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          description: 'The schema here is documentation, not validation.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['floor'],
                properties: { floor: { type: 'number' }, label: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
});

const byName = (tools: DerivedTool[], name: string): DerivedTool => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name} was derived`);
  return tool;
};

describe('toolsFromDocument, on a fixture document', () => {
  it('names each tool after its operationId and keeps its method and path', () => {
    const band = byName(toolsFromDocument(fixture()), 'putBand');
    expect(band.method).toBe('put');
    expect(band.path).toBe('/api/projects/{id}/bands/{stepId}');
    expect(band.description).toContain('Set a band');
    expect(band.description).toContain('Bands are derived downstream.');
  });

  // Watched red for task 2.1. Synthesise a name from the path instead of
  // throwing — `${method}${path.replaceAll('/', '')}` or anything like it — and
  // this test must fail. Two paths that collapse to one synthesised name leave
  // one tool silently shadowing the other.
  it('throws on an operation with no operationId rather than synthesising one', () => {
    const document = fixture();
    delete document.paths['/api/projects/{id}']?.['get']?.operationId;
    expect(() => toolsFromDocument(document)).toThrow(
      /GET \/api\/projects\/\{id\} has no operationId/,
    );
  });

  it('emits no tool for any of D1’s three exclusion classes', () => {
    const names = toolsFromDocument(fixture()).map((tool) => tool.name);
    expect(names).not.toContain('getHealth');
    expect(names).not.toContain('getMetrics');
    expect(names).not.toContain('postApiSmokeEcho');
    expect(names).not.toContain('postApiAuthLogin');
    expect(names).not.toContain('postInternalForward');
    expect([...names].sort()).toEqual(['getApiProjects', 'getApiProjectsById', 'putBand']);
  });

  // Watched red for task 2.3. Drop the stale check and this passes with an
  // exclusion list that has quietly stopped excluding anything — which is how a
  // renamed `/internal/*` route reappears as a callable tool.
  it('throws when an exclusion entry matches nothing in the document', () => {
    const document = fixture();
    delete document.paths['/internal/forward'];
    expect(() => toolsFromDocument(document)).toThrow('exclusion list names');
  });

  it('excludes a whole prefix, not just the path that was named', () => {
    const document = fixture();
    document.paths['/internal/resume'] = { post: { operationId: 'postInternalResume' } };
    expect(toolsFromDocument(document).map((tool) => tool.name)).not.toContain(
      'postInternalResume',
    );
  });

  // Task 2.4's other half: a route the document gained must appear, not be
  // filtered by anything this module keeps to itself.
  it('emits a route the document gained rather than filtering it silently', () => {
    const document = fixture();
    document.paths['/api/invented'] = { get: { operationId: 'getApiInvented' } };
    expect(toolsFromDocument(document).map((tool) => tool.name)).toContain('getApiInvented');
  });

  it('merges body properties with path parameters and keeps both sides required', () => {
    const band = byName(toolsFromDocument(fixture()), 'putBand');
    expect(Object.keys(band.inputSchema.properties).sort()).toEqual([
      'floor',
      'id',
      'label',
      'stepId',
    ]);
    expect([...(band.inputSchema.required ?? [])].sort()).toEqual(['floor', 'id', 'stepId']);
    expect(band.locations).toEqual({ id: 'path', stepId: 'path', floor: 'body', label: 'body' });
    expect(band.inputSchema.properties['floor']).toEqual({ type: 'number' });
    expect(band.inputSchema.additionalProperties).toBe(false);
  });

  it('leaves an optional query parameter optional', () => {
    const list = byName(toolsFromDocument(fixture()), 'getApiProjects');
    expect(list.locations).toEqual({ q: 'query' });
    expect(list.inputSchema.required).toBeUndefined();
  });

  it('refuses a parameter it cannot send instead of dropping it', () => {
    const document = fixture();
    document.paths['/api/projects/{id}']?.['get']?.parameters?.push({
      name: 'x-tenant',
      in: 'header',
      schema: { type: 'string' },
    });
    expect(() => toolsFromDocument(document)).toThrow(/"x-tenant" in "header"/);
  });

  it('refuses a name claimed by both a parameter and a body property', () => {
    const document = fixture();
    const body = document.paths['/api/projects/{id}/bands/{stepId}']?.['put']?.requestBody;
    const properties = body?.content?.['application/json']?.schema?.properties;
    if (properties === undefined) throw new Error('the fixture lost its body schema');
    properties['id'] = { type: 'string' };
    expect(() => toolsFromDocument(document)).toThrow(
      /"id" is declared as both a path input and a body input/,
    );
  });

  it('passes a request body’s own description through unedited (D8)', () => {
    expect(byName(toolsFromDocument(fixture()), 'putBand').description).toContain(
      'The schema here is documentation, not validation.',
    );
  });

  it('says so when the document carries no prose, rather than inventing any', () => {
    expect(byName(toolsFromDocument(fixture()), 'getApiProjectsById').description).toBe(
      'GET /api/projects/{id} — the OpenAPI document carries no prose for this operation.',
    );
  });

  it('refuses a document with no paths', () => {
    expect(() => toolsFromDocument({})).toThrow(/no paths/);
  });
});

describe('toolsFromDocument, on the generated document', () => {
  const document = readDocument();
  const tools = toolsFromDocument(document);

  /**
   * The drift test (task 2.4). The expected side is walked here, separately from
   * the derivation, so the two can disagree: a route added to be-01 and
   * regenerated into `openapi.json` lands in this set and must land in the
   * generated one too.
   */
  it('derives exactly one tool per non-excluded operation in the document', () => {
    const expected = Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        Object.values(item ?? {}).map((operation) =>
          isExcluded(path) ? undefined : operation?.operationId,
        ),
      )
      .filter((id): id is string => id !== undefined);

    expect(tools.map((tool) => tool.name).sort()).toEqual([...expected].sort());
  });

  /**
   * A new tool requires an explicit surface decision, independently of registry iteration.
   * Optimizer Retry belongs because it is a project-scoped lifecycle action with no
   * `commands` equivalent.
   */
  it('is 33 tools, so a route that appears must be decided about', () => {
    expect(tools).toHaveLength(33);
    expect(EXCLUDED_PATHS).toHaveLength(3);
  });

  it('offers batches, not single writes (plan-commands)', () => {
    // Proof: `/api/work-items/*` dropped from `EXCLUDED_PATHS`, this failed on
    // `expected [] to have a length of 0` with sixteen names in it. Watched,
    // 2026-08-29.
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('postApiProjectsByIdCommands');
    expect(names).toContain('postApiDirectoryCommands');
    expect(tools.filter((tool) => tool.path.startsWith('/api/work-items/'))).toHaveLength(0);
    for (const single of [
      'postApiProjectsByIdWork-items',
      'postApiTeams',
      'patchApiTeamsById',
      'deleteApiTeamsById',
      'postApiPeople',
      'postApiTags',
      'postApiServices',
      'putApiProjectsByIdTeamsByTeamIdCapacity',
      'putApiProjectsByIdPriority-bands',
      'postApiProjectsByIdFreeze',
    ]) {
      expect(names).not.toContain(single);
    }
    // The reads that share a path with an excluded write are still here.
    expect(names).toContain('getApiProjectsByIdWork-items');
    expect(names).toContain('getApiTeams');
  });

  it('describes every command kind in the commands tool, so a model needs no other document', () => {
    const commands = byName(tools, 'postApiProjectsByIdCommands');
    const list = commands.inputSchema.properties['commands'] as {
      items: {
        anyOf: { description: string; properties: { kind: { const: string } } }[];
      };
    };
    // **33 to 36 with `work-item-types`**: `createWorkItemType`,
    // `patchWorkItemType` and `deleteWorkItemType`, the same trio every other
    // directory vocabulary carries. The count is pinned rather than derived so a
    // command kind cannot arrive in be-01 without a model being told about it —
    // which is precisely what this red is, arriving from a change gated on
    // `-p be-01`.
    expect(list.items.anyOf).toHaveLength(36);
    for (const variant of list.items.anyOf) {
      expect(variant.description.length).toBeGreaterThan(10);
      expect(typeof variant.properties.kind.const).toBe('string');
    }
  });

  it('derives a path-parameter-only read the way the document declares it', () => {
    const workItems = byName(tools, 'getApiProjectsByIdWork-items');
    expect(workItems.method).toBe('get');
    expect(workItems.path).toBe('/api/projects/{id}/work-items');
    expect(workItems.inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('derives a write with path parameters and a body from both sides', () => {
    // The step rename: two path parameters and a typebox body. Until
    // `plan-commands` this read the estimate PUT, which is a batch command now.
    const rename = byName(tools, 'patchApiProjectsByIdStepsByStepId');
    expect(rename.method).toBe('patch');
    expect(Object.keys(rename.inputSchema.properties).sort()).toEqual(['id', 'name', 'stepId']);
    expect([...(rename.inputSchema.required ?? [])].sort()).toEqual(['id', 'name', 'stepId']);
    expect(rename.locations['stepId']).toBe('path');
    expect(rename.locations['name']).toBe('body');
    expect(byName(tools, 'postApiProjectsByIdCommands').description).toContain('all or none');
  });

  it('keeps the history filters optional and in the query string', () => {
    const history = byName(tools, 'getApiProjectsByIdHistory');
    expect(history.locations).toEqual({ id: 'path', workItemId: 'query', kind: 'query' });
    expect(history.inputSchema.required).toEqual(['id']);
  });

  it('gives every tool a name the MCP protocol accepts and a description', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The README against the tools it documents.
 *
 * `apps/mcp-01/README.md` is the list a person reads before writing a client,
 * and it is on disk rather than derived, so nothing but this stops it drifting
 * from `openapi.json`. `steps-not-phases` renamed both a tool and a command
 * field, which is exactly the drift this catches.
 */
describe('the README names the tools that exist', () => {
  const tools = toolsFromDocument(readDocument());
  const readme = readFileSync(new URL('../README.md', import.meta.url).pathname, 'utf8');

  it('names no tool the document does not derive', () => {
    const named = [...readme.matchAll(/\b(?:get|post|patch|put|delete)Api[A-Za-z-]+\b/g)].map(
      (found) => found[0],
    );
    // Non-vacuous: the README does name tools, so an empty intersection below
    // would be a regex that stopped matching rather than a document that agrees.
    expect(named.length).toBeGreaterThan(0);

    const derived = new Set(tools.map((tool) => tool.name));
    expect(named.filter((name) => !derived.has(name))).toEqual([]);

    /*
      And the prose beside the names, which no schema checks. The README
      describes the tool set in words — "the project and step routes" — and a
      sentence is where a rename survives a green gate.

      Proof: that clause spelled back to "the project and role routes". This
      failed on `expect(received).not.toMatch(expected)` with
      `Received: "…undo, redo, the project and role routes, the export…"`.
      Watched 2026-08-29.
    */
    expect(readme).not.toMatch(/\b(phase|phases|role|roles)\b/i);
  });

  it('counts them the same way the document does', () => {
    /*
      The README said "Twenty tools in all" while this file asserted 22 — a
      figure nobody could see was wrong, in the one document a person reads
      before writing a client. The names were already checked above and the
      count was not, so two tools could be added and the sentence stay put.

      Proof: the README's "22 tools in all" spelled back to "Twenty tools in
      all". This failed on `expect(received).not.toBeNull()` — the digits are
      what makes the claim checkable, so writing the number as a word is itself
      the drift. With "20 tools in all" it failed on
      `expect(received).toBe(expected) · Expected: 22 · Received: 20`.
      Watched 2026-09-02.
    */
    const claimed = /\b(\d+) tools in all\b/.exec(readme);
    expect(claimed).not.toBeNull();
    expect(Number(claimed?.[1])).toBe(tools.length);
  });

  it('spells the example batch in the fields the commands tool declares', () => {
    /*
      Proof: `"stepId"` in the README's `setEstimate` example spelled back to
      `"roleId"` — the drift `steps-not-phases` would have left behind. This
      failed on `expect(received).toEqual(expected) … + [ "setEstimate.roleId" ]`.
      Watched 2026-08-29.
    */
    const fenced = /```json\n([\s\S]*?)```/.exec(readme)?.[1];
    if (fenced === undefined) throw new Error('the README has no json example to check');
    const example = JSON.parse(fenced) as { commands: Record<string, unknown>[] };

    const variants = (
      byName(tools, 'postApiProjectsByIdCommands').inputSchema.properties['commands'] as {
        items: { anyOf: { properties: Record<string, unknown> & { kind: { const: string } } }[] };
      }
    ).items.anyOf;

    const undeclared: string[] = [];
    for (const command of example.commands) {
      const kind = command['kind'];
      const variant = variants.find((each) => each.properties.kind.const === kind);
      if (variant === undefined) {
        undeclared.push(`${String(kind)} is not a command kind`);
        continue;
      }
      for (const field of Object.keys(command)) {
        // `…Ref` names something an earlier command in the same batch created;
        // it stands in for the `…Id` the variant declares, which is why the
        // variant carries both.
        if (!(field in variant.properties)) undeclared.push(`${String(kind)}.${field}`);
      }
    }

    expect(undeclared).toEqual([]);
    // Non-vacuous: the example really was read and really was matched to
    // variants, so an empty list is agreement rather than an empty loop.
    expect(example.commands.length).toBeGreaterThan(2);
    expect(example.commands.some((command) => command['kind'] === 'setEstimate')).toBe(true);
  });
});

describe('readDocument', () => {
  it('names the path it could not read', () => {
    expect(() => readDocument('/nowhere/openapi.json')).toThrow(
      /cannot read the OpenAPI document at \/nowhere\/openapi\.json/,
    );
  });
});
