import { type JsonSchema, type } from 'arktype';
import { describe, expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

const batch = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/commands',
  operationId: 'applyPlanCommands',
  policies: [],
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
  refusals: [{ status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) }],
  document: { summary: 'Apply plan commands' },
});

describe('documentFromShapes', () => {
  test('emits inline object bodies with intact nested union arms and optional fields', () => {
    const document = documentFromShapes([batch]);
    expect(document.openapi).toBe('3.1.0');
    const operation = document.paths['/api/projects/{id}/commands']?.['post'];
    expect(operation?.operationId).toBe('applyPlanCommands');
    expect(operation?.requestBody?.content['application/json']?.schema).toEqual(
      batch.body.jsonSchema,
    );
    expect(operation?.requestBody?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      required: ['commands'],
      properties: {
        label: { type: 'string' },
        commands: {
          type: 'array',
          items: {
            anyOf: [
              { properties: { kind: { const: 'remove' }, id: { type: 'string' } } },
              { properties: { kind: { const: 'rename' }, name: { type: 'string' } } },
            ],
          },
        },
      },
    });
    expect(operation?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'preview', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(operation?.responses['400']?.content?.['application/json']?.schema).toEqual(
      batch.refusals[0].schema.jsonSchema,
    );
  });
  test('refuses absent or duplicate operation names and duplicate method paths', () => {
    expect(() => documentFromShapes([{ ...batch, operationId: '' }])).toThrow('operationId');
    expect(() => documentFromShapes([batch, { ...batch, path: '/other' }])).toThrow('operationId');
    expect(() => documentFromShapes([batch, { ...batch, operationId: 'other' }])).toThrow(
      'duplicate route',
    );
  });
  test('reads descriptors without accessing validator internals', () => {
    const declaration = {
      ...batch.body,
      get validator(): never {
        throw new Error('validator accessed');
      },
    };
    expect(
      documentFromShapes([{ ...batch, body: declaration }]).paths['/api/projects/{id}/commands']?.[
        'post'
      ]?.requestBody?.content['application/json']?.schema,
    ).toEqual(batch.body.jsonSchema);
  });
  test('emits text and empty representations without inventing JSON bodies', () => {
    const document = documentFromShapes([
      {
        ...batch,
        responses: [
          { kind: 'empty', status: 204 },
          { kind: 'empty', status: 302 },
          { kind: 'text', status: 200, contentType: 'text/plain' },
        ],
      },
    ]);
    const replies = document.paths['/api/projects/{id}/commands']?.['post']?.responses;
    expect(replies?.['204']).toEqual({ description: 'Success' });
    expect(replies?.['302']).toEqual({ description: 'Success' });
    expect(replies?.['200']?.content?.['text/plain']?.schema).toEqual({ type: 'string' });
  });
});

test('refuses non-object query descriptors instead of silently losing their inputs', () => {
  for (const query of [requestSchema(type('string')), requestSchema(type('string[]'))]) {
    expect(() => documentFromShapes([{ ...batch, query }])).toThrow(
      'parameter schema must be an inline object',
    );
  }
});

test('refuses a declared parameter object that omits a route segment', () => {
  expect(() =>
    documentFromShapes([{ ...batch, params: requestSchema(type({ other: 'string' })) }]),
  ).toThrow('missing path parameter descriptor: id');
  expect(() =>
    documentFromShapes([
      {
        ...batch,
        path: '/api/projects/:id/commands/:commandId',
        params: requestSchema(type({ id: 'string' })),
      },
    ]),
  ).toThrow('missing path parameter descriptor: commandId');
});

test('refuses whitespace operation names and colliding methods at a converted path', () => {
  expect(() => documentFromShapes([{ ...batch, operationId: '  \n ' }])).toThrow('operationId');
  expect(() =>
    documentFromShapes([
      batch,
      { ...batch, path: '/api/projects/{id}/commands', operationId: 'collision' },
    ]),
  ).toThrow('duplicate route');
});

test('preserves response alternatives and media types without overwriting a status', () => {
  const replies = documentFromShapes([
    {
      ...batch,
      responses: [
        { kind: 'json', status: 200, schema: responseSchema(type({ kind: "'first'" })) },
        { kind: 'json', status: 200, schema: responseSchema(type({ kind: "'second'" })) },
        { kind: 'json', status: 200, schema: responseSchema(type({ kind: "'third'" })) },
        { kind: 'text', status: 200, contentType: 'text/plain' },
      ],
      refusals: [
        { status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) },
        { status: 400, schema: responseSchema(type({ error: "'invalid_query'" })) },
      ],
    },
  ]).paths['/api/projects/{id}/commands']?.['post']?.responses;
  expect(replies?.['200']?.content?.['application/json']?.schema).toMatchObject({
    anyOf: [
      {
        anyOf: [
          { properties: { kind: { const: 'first' } } },
          { properties: { kind: { const: 'second' } } },
        ],
      },
      { properties: { kind: { const: 'third' } } },
    ],
  });
  expect(replies?.['200']?.content?.['text/plain']?.schema).toEqual({ type: 'string' });
  expect(replies?.['400']?.content?.['application/json']?.schema).toMatchObject({
    anyOf: [
      { properties: { error: { const: 'invalid_body' } } },
      { properties: { error: { const: 'invalid_query' } } },
    ],
  });
});

test('refuses ambiguous repeated empty statuses', () => {
  expect(() =>
    documentFromShapes([
      {
        ...batch,
        responses: [
          { kind: 'empty', status: 204 },
          { kind: 'empty', status: 204 },
        ],
      },
    ]),
  ).toThrow('ambiguous empty response at 204');
});

test('emits a typed refusal independently of where its empty alternative is declared', () => {
  const typed = {
    status: 400,
    schema: responseSchema(type({ error: "'invalid_body'" })),
  } as const;
  const empty = { kind: 'empty', status: 400 } as const;
  const responses = (
    refusals: readonly [typeof empty, typeof typed] | readonly [typeof typed, typeof empty],
  ) =>
    documentFromShapes([{ ...batch, refusals }]).paths['/api/projects/{id}/commands']?.['post']
      ?.responses;

  expect(responses([empty, typed])).toEqual(responses([typed, empty]));
  expect(responses([empty, typed])?.['400']?.content?.['application/json']?.schema).toEqual(
    typed.schema.jsonSchema,
  );
});

test('refuses object-level query constraints that cannot become named parameters', () => {
  const indexed = requestSchema(type({ '[string]': 'string' }));
  // Without the explicit mode, an indexed query is still refused rather than
  // changing the meaning of every existing closed query declaration.
  expect(() => documentFromShapes([{ ...batch, query: indexed }])).toThrow(
    'cannot flatten parameter schema',
  );
  for (const constraint of [
    { minProperties: 1 },
    { maxProperties: 2 },
    { patternProperties: { '^x': { type: 'string' as const } } },
  ]) {
    const query = { ...batch.query, jsonSchema: { ...batch.query.jsonSchema, ...constraint } };
    expect(() => documentFromShapes([{ ...batch, query }])).toThrow(
      'cannot flatten parameter schema',
    );
  }
});

test('documents arbitrary singleton query keys as one exploded form object', () => {
  const openQuery = defineEndpointShape({
    ...batch,
    query: requestSchema(type({ '[string]': 'string' })),
    queryMode: 'arbitrary-singleton',
  });
  const operation = documentFromShapes([openQuery]).paths['/api/projects/{id}/commands']?.['post'];
  expect(operation?.parameters).toEqual([
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    {
      name: 'query',
      in: 'query',
      required: false,
      style: 'form',
      explode: true,
      schema: openQuery.query.jsonSchema,
    },
  ]);
});

test('refuses malformed arbitrary-singleton declarations before emitting them', () => {
  const closed = { ...batch, queryMode: 'arbitrary-singleton' as const };
  const namedAndOpen = {
    ...batch,
    query: requestSchema(type({ 'state?': 'string', '[string]': 'string' })),
    queryMode: 'arbitrary-singleton' as const,
  };
  const constrainedValues = {
    ...batch,
    query: {
      ...requestSchema(type({ '[string]': 'string' })),
      jsonSchema: {
        type: 'object' as const,
        additionalProperties: { type: 'string' as const, minLength: 1 },
      },
    },
    queryMode: 'arbitrary-singleton' as const,
  };
  const queryless = {
    ...batch,
    query: undefined,
    queryMode: 'arbitrary-singleton' as const,
  };
  for (const shape of [closed, namedAndOpen, constrainedValues, queryless]) {
    expect(() => defineEndpointShape(shape)).toThrow('arbitrary-singleton query');
    expect(() => documentFromShapes([shape])).toThrow('arbitrary-singleton query');
  }
});

function queryModeFixtures() {
  const { query: omitted, ...queryless } = batch;
  void omitted;
  // @ts-expect-error An arbitrary-singleton mode requires a query validator.
  defineEndpointShape({ ...queryless, queryMode: 'arbitrary-singleton' });
}
void queryModeFixtures;

test('refuses references in every descriptor location without reading validators', () => {
  const schema = {
    ...requestSchema(type({ id: 'string' })),
    jsonSchema: { $ref: '#/$defs/missing' } as JsonSchema,
  };
  for (const shape of [
    { ...batch, params: schema },
    { ...batch, query: schema },
    { ...batch, body: schema },
    { ...batch, responses: [{ kind: 'json' as const, status: 200 as const, schema }] },
    {
      ...batch,
      refusals: [
        {
          status: 400 as const,
          schema: { ...batch.refusals[0].schema, jsonSchema: schema.jsonSchema },
        },
      ],
    },
  ]) {
    expect(() => documentFromShapes([shape])).toThrow('HTTP wire schemas must be inline');
  }
});

test('finds references only in supported schema-valued keywords', () => {
  const reference: JsonSchema = { $ref: '#/$defs/missing' };
  for (const jsonSchema of [
    { anyOf: [reference] },
    { oneOf: [reference] },
    { allOf: [reference] },
    { not: reference },
    { $defs: { hidden: reference } },
    { type: 'object', properties: { tree: reference } },
    { type: 'object', patternProperties: { '^tree': reference } },
    { type: 'object', additionalProperties: reference },
    { type: 'array', items: reference },
    { type: 'array', items: [reference] },
    { type: 'array', prefixItems: [reference] },
    { type: 'array', contains: reference },
    { type: 'array', additionalItems: reference },
  ] satisfies JsonSchema[]) {
    expect(() => documentFromShapes([{ ...batch, body: { ...batch.body, jsonSchema } }])).toThrow(
      'HTTP wire schemas must be inline',
    );
  }
  const body = {
    ...batch.body,
    jsonSchema: {
      type: 'object',
      properties: {
        $ref: { type: 'string' },
        literal: { const: { $ref: '#/$defs/literal' } },
      },
      default: { $ref: '#/$defs/literal' },
      examples: [{ $ref: '#/$defs/literal' }],
    } satisfies JsonSchema,
  };
  expect(
    documentFromShapes([{ ...batch, body }]).paths['/api/projects/{id}/commands']?.['post']
      ?.requestBody?.content['application/json']?.schema,
  ).toMatchObject({
    properties: { $ref: { type: 'string' }, literal: { const: { $ref: '#/$defs/literal' } } },
    default: { $ref: '#/$defs/literal' },
    examples: [{ $ref: '#/$defs/literal' }],
  });
});

test('declares exactly the accepted body media while retaining one inline schema', () => {
  const shape = defineEndpointShape({
    ...batch,
    bodyMedia: ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
  });
  const content = documentFromShapes([shape]).paths['/api/projects/{id}/commands']?.['post']
    ?.requestBody?.content;
  expect(Object.keys(content ?? {})).toEqual([
    'application/json',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
  ]);
  expect(content?.['multipart/form-data']?.schema).toEqual(batch.body.jsonSchema);
});

test('refuses malformed erased body media declarations before emitting a document', () => {
  for (const bodyMedia of [[], ['text/plain'], ['application/json']]) {
    const shape = {
      ...batch,
      bodyMedia,
      ...(bodyMedia[0] === 'application/json' ? { body: undefined } : {}),
    };
    expect(() => documentFromShapes([shape as unknown as typeof batch])).toThrow();
    expect(() => defineEndpointShape(shape as unknown as typeof batch)).toThrow();
  }
});

function mediaTypeFixtures() {
  // @ts-expect-error A declared body media list cannot be empty.
  defineEndpointShape({ ...batch, bodyMedia: [] });
  // @ts-expect-error Text is not an accepted structural body decoder.
  defineEndpointShape({ ...batch, bodyMedia: ['text/plain'] });
  const { body: omitted, ...bodyless } = batch;
  void omitted;
  // @ts-expect-error Media declarations require a body schema.
  defineEndpointShape({ ...bodyless, bodyMedia: ['application/json'] });
}
void mediaTypeFixtures;
