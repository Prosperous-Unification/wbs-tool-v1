import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineEndpointShape,
  documentFromShapes,
  requestSchema,
  responseSchema,
  type SchemaShape,
} from '@wbs/contracts';
import { type } from '@wbs/validation';
import { expect, it } from 'bun:test';

import { readDocument, toolsFromDocument } from './openapi-tools';

const commands = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/commands',
  operationId: 'applyPlanCommands',
  policies: [],
  params: requestSchema(type({ id: 'string' })),
  query: requestSchema(type({ 'preview?': 'string' })),
  body: requestSchema(
    type({
      commands: type({ kind: "'rename'", name: 'string' })
        .or({ kind: "'remove'", id: 'string' })
        .array(),
      'label?': 'string',
    }),
  ),
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ applied: 'number' })) }],
  refusals: [],
  document: { summary: 'Apply plan commands' },
});

/** The fixture covers every production exclusion so stale exclusions still fail in the consumer. */
function deriveTools(body: SchemaShape<unknown> = commands.body) {
  const excluded = [
    '/api/auth/login',
    '/internal/forward',
    '/health',
    '/metrics',
    '/api/smoke/echo',
  ] as const;
  const shapes = [
    { ...commands, body },
    ...excluded.map((path, index) =>
      defineEndpointShape({
        method: 'GET',
        path,
        operationId: `excluded${String(index)}`,
        policies: [],
        responses: [{ kind: 'empty', status: 204 }],
        refusals: [],
        document: { summary: 'Excluded operation' },
      }),
    ),
  ];
  const directory = mkdtempSync(join(tmpdir(), 'wbs-shape-document-'));
  const file = join(directory, 'openapi.json');
  try {
    writeFileSync(file, JSON.stringify(documentFromShapes(shapes)));
    return toolsFromDocument(readDocument(file));
  } finally {
    rmSync(directory, { recursive: true });
  }
}

it('derives the named MCP tool with all path/query/body inputs and exclusions from emitted shapes', () => {
  const tools = deriveTools();
  expect(tools.map((tool) => tool.name)).toEqual(['applyPlanCommands']);
  const tool = tools[0];
  expect(tool.path).toBe('/api/projects/{id}/commands');
  expect(tool.method).toBe('post');
  expect(tool.description).toBe('Apply plan commands');
  expect(tool.locations).toEqual({ id: 'path', preview: 'query', commands: 'body', label: 'body' });
  expect(tool.inputSchema.required).toEqual(['id', 'commands']);
  expect(tool.inputSchema.properties['label']).toEqual({ type: 'string' });
  expect(tool.inputSchema.properties['preview']).toEqual({ type: 'string' });
  expect(tool.inputSchema.additionalProperties).toBe(false);
});

it('keeps both nested command alternatives usable in the derived MCP input schema', () => {
  const tool = deriveTools()[0];
  expect(tool.inputSchema.properties['commands']).toMatchObject({
    type: 'array',
    items: {
      anyOf: [
        {
          type: 'object',
          properties: { kind: { const: 'remove' }, id: { type: 'string' } },
          required: ['id', 'kind'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { kind: { const: 'rename' }, name: { type: 'string' } },
          required: ['kind', 'name'],
          additionalProperties: false,
        },
      ],
    },
  });
});

it('refuses recursive declarations before publishing MCP inputs with unresolved references', () => {
  const node = type.scope({ node: { name: 'string', 'children?': 'node[]' } }).export().node;
  expect(JSON.stringify(node.toJsonSchema())).toContain('"$ref"');
  let reachedEmission = false;
  expect(() => {
    const body = requestSchema(type({ tree: node }));
    reachedEmission = true;
    deriveTools(body);
  }).toThrow('HTTP wire schemas must be inline');
  expect(reachedEmission).toBe(false);
});

it('refuses structural descriptors whose nested references would lose their definition context', () => {
  const node = type.scope({ node: { name: 'string', 'children?': 'node[]' } }).export().node;
  const jsonSchema = {
    type: 'object' as const,
    properties: { tree: node.toJsonSchema() },
    required: ['tree'],
    additionalProperties: false,
  };
  expect(JSON.stringify(jsonSchema)).toContain('"$ref"');
  expect(() => deriveTools({ ...commands.body, jsonSchema })).toThrow(
    'HTTP wire schemas must be inline',
  );
});

it('preserves literal $ref fields and const objects in emitted MCP inputs', () => {
  const body = requestSchema(type({ $ref: 'string', literal: 'unknown' }));
  const tools = deriveTools({
    ...body,
    jsonSchema: {
      type: 'object',
      properties: { $ref: { type: 'string' }, literal: { const: { $ref: '#/$defs/literal' } } },
      required: ['$ref', 'literal'],
      additionalProperties: false,
    },
  });
  expect(tools[0].inputSchema.properties).toMatchObject({
    $ref: { type: 'string' },
    literal: { const: { $ref: '#/$defs/literal' } },
  });
  expect(tools[0].inputSchema.required).toEqual(['id', '$ref', 'literal']);
});
