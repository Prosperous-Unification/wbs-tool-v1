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
    '/api/projects/{id}/bands/{roleId}': {
      put: {
        operationId: 'putBand',
        summary: 'Set a band',
        description: 'Bands are derived downstream.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'roleId', in: 'path', required: true, schema: { type: 'string' } },
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
    expect(band.path).toBe('/api/projects/{id}/bands/{roleId}');
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
    delete document.paths['/health'];
    expect(() => toolsFromDocument(document)).toThrow(/"\/health".*no longer contains/s);
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
      'roleId',
    ]);
    expect([...(band.inputSchema.required ?? [])].sort()).toEqual(['floor', 'id', 'roleId']);
    expect(band.locations).toEqual({ id: 'path', roleId: 'path', floor: 'body', label: 'body' });
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
    const body = document.paths['/api/projects/{id}/bands/{roleId}']?.['put']?.requestBody;
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
      'GET /api/projects/{id} — the committed OpenAPI document carries no prose for this operation.',
    );
  });

  it('refuses a document with no paths', () => {
    expect(() => toolsFromDocument({})).toThrow(/no paths/);
  });
});

describe('toolsFromDocument, on the committed document', () => {
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
   * A count, deliberately. A new be-01 route arrives here as a red test rather
   * than as a tool nobody decided about — the reader has to say whether it is
   * plan surface or a new exclusion. 59 operations in the document, 8 excluded
   * (3 auth, 2 internal, health, metrics, smoke echo).
   *
   * It went from 43 to 47 when `service-split` added the directory's four
   * service routes, and the decision it forced was made rather than skipped:
   * they are **plan surface**, exactly as `/api/tags` and `/api/teams` already
   * are. An agent that can label a work item with a service has to be able to
   * see the vocabulary and add to it, and the removal keeps its 409-then-confirm
   * shape through the tool as it does through the route.
   *
   * **47 to 49 with `token-tracking`'s two measure routes**, and the decision is
   * the one Dany asked for on 2026-08-21 19:06 — token figures must be reachable
   * from MCP as well. `putApiWork-itemsByIdMeasuresByMetricByRoleId` and
   * `deleteApiWork-itemsByIdMeasuresByMetricByRoleId` are the tools, derived
   * from the committed document with nothing added here: neither path matches an
   * exclusion class, so "free" turned out to be true — but this line is what
   * checked it rather than assuming it.
   *
   * **49 to 51 with the OIDC solution contract.** Both reads are plan surface:
   * an agent needs the slug lookup to resolve the plan for a solution and the
   * export route to retrieve that plan as JSON or Markdown.
   *
   * It arrived as a **red four chunks late**, because those chunks gated
   * `-p be-01` and this drift test lives in `mcp-01`. A count that only one
   * project's gate can see is a count that drifts silently; the routes landed at
   * `2ad567c` in chunk 7 and were noticed at `e82b023` in chunk 14.
   */
  it('is 20 tools, so a route that appears must be decided about', () => {
    // **51 to 19 with `plan-commands`.** Every single-item plan and directory
    // write is excluded — a model gets one write tool, `commands`, and cannot
    // pick the slow path — and the batch route arrives. What stays: the reads,
    // `commands`, undo, redo, the project and role routes that are not plan
    // edits, the export, and the directory's own batch route (the directory
    // has no project). The single-item routes are gone from be-01, so nothing
    // needs excluding beyond the five classes.
    expect(tools).toHaveLength(20);
    expect(EXCLUDED_PATHS).toHaveLength(5);
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
        oneOf: { title: string; description: string; properties: { kind: { enum: string[] } } }[];
      };
    };
    expect(list.items.oneOf).toHaveLength(33);
    for (const variant of list.items.oneOf) {
      expect(variant.description.length).toBeGreaterThan(10);
      expect(variant.properties.kind.enum).toEqual([variant.title]);
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
    // The role rename: two path parameters and a typebox body. Until
    // `plan-commands` this read the estimate PUT, which is a batch command now.
    const rename = byName(tools, 'patchApiProjectsByIdRolesByRoleId');
    expect(rename.method).toBe('patch');
    expect(Object.keys(rename.inputSchema.properties).sort()).toEqual(['id', 'name', 'roleId']);
    expect([...(rename.inputSchema.required ?? [])].sort()).toEqual(['id', 'name', 'roleId']);
    expect(rename.locations['roleId']).toBe('path');
    expect(rename.locations['name']).toBe('body');
    // And the one hand-parsed write left says so, as the eight used to.
    expect(byName(tools, 'postApiProjectsByIdCommands').description).toContain(
      'documentation, not validation',
    );
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

describe('readDocument', () => {
  it('names the path it could not read', () => {
    expect(() => readDocument('/nowhere/openapi.json')).toThrow(
      /cannot read the OpenAPI document at \/nowhere\/openapi\.json/,
    );
  });
});
