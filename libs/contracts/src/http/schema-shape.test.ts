import { Ajv2020 } from 'ajv/dist/2020';
import { type } from 'arktype';
import { describe, expect, spyOn, test } from 'bun:test';

import { requestSchema, responseSchema, validateSchema } from './schema-shape';

describe('the HTTP schema declaration boundary', () => {
  const commands = type({
    commands: type
      .or(
        { kind: "'rename'", name: 'string', 'note?': 'string' },
        { kind: "'remove'", id: 'string', 'cascade?': 'boolean' },
      )
      .array(),
  });

  test('refuses an undeclared nested command field without mutating the request', async () => {
    const shape = requestSchema(commands);
    const body = { commands: [{ kind: 'rename', name: 'Plan', extra: 'keep' }] };
    const validation = await validateSchema(shape, body);
    expect(validation.issues).toBeDefined();
    expect(body.commands[0]?.extra).toBe('keep');
    expect(
      (await validateSchema(shape, { commands: [{ kind: 'rename', name: 'Plan' }] })).issues,
    ).toBeUndefined();
  });

  test('deletes undeclared request fields only when the contract opts in', async () => {
    const shape = requestSchema(type({ objective: "'pri' | 'time'", inputHash: 'string' }), {
      undeclaredKeys: 'delete',
    });
    const body = { objective: 'pri', inputHash: 'held', ignored: 'future-field' };

    expect(await validateSchema(shape, body)).toEqual({
      value: { objective: 'pri', inputHash: 'held' },
    });
    expect(body).toHaveProperty('ignored', 'future-field');
    expect(
      (await validateSchema(shape, { objective: 'quickest', inputHash: 'held', ignored: true }))
        .issues,
    ).toBeDefined();
  });

  test('emits both nested command arms and optional fields from the same declaration', () => {
    const shape = requestSchema(commands);
    expect(shape.jsonSchema).toMatchObject({
      type: 'object',
      required: ['commands'],
      additionalProperties: false,
      properties: {
        commands: {
          type: 'array',
          items: {
            anyOf: [
              {
                type: 'object',
                properties: { id: { type: 'string' }, cascade: { type: 'boolean' } },
                required: ['id', 'kind'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { name: { type: 'string' }, note: { type: 'string' } },
                required: ['kind', 'name'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
    });
  });

  test('retains additive reply fields while refusing a changed known field type', async () => {
    const shape = responseSchema(type({ project: { name: 'string' } }));
    const reply = { project: { name: 'Plan', newFlag: true }, newVersion: 2 };
    expect(await validateSchema(shape, reply)).toMatchObject({ value: reply });
    expect((await validateSchema(shape, { project: { name: 42 } })).issues).toBeDefined();
  });

  test('rejects an unsupported predicate instead of advertising an unconstrained schema', () => {
    expect(() => requestSchema(type.number.narrow((number) => number % 3 === 0))).toThrow();
  });

  test('rejects an unvalidated morph whose projected output would erase its constraint', () => {
    expect(() => responseSchema(type.string.pipe((text) => text.length))).toThrow();
  });

  test('rejects defaults whose input and output contracts differ', () => {
    expect(() => requestSchema(type({ count: 'number = 3' }))).toThrow();
  });

  test('refuses recursive request and reply descriptors before their references can escape', () => {
    const recursive = type.scope({ node: { name: 'string', 'children?': 'node[]' } }).export().node;
    expect(JSON.stringify(recursive.toJsonSchema())).toContain('"$ref"');
    expect(() => requestSchema(type({ tree: recursive }))).toThrow(
      'HTTP wire schemas must be inline',
    );
    expect(() => responseSchema(type({ tree: recursive }))).toThrow(
      'HTTP wire schemas must be inline',
    );
  });

  test('keeps literal fields named $ref valid in strict requests and tolerant replies', async () => {
    const declaration = type({ $ref: 'string', nested: { $ref: "'#/$defs/literal'" } });
    for (const shape of [requestSchema(declaration), responseSchema(declaration)]) {
      expect(
        await validateSchema(shape, { $ref: 'literal', nested: { $ref: '#/$defs/literal' } }),
      ).toMatchObject({
        value: { $ref: 'literal', nested: { $ref: '#/$defs/literal' } },
      });
    }
  });

  test('awaits Standard Schema validation even when the declared validator is asynchronous', async () => {
    const declared = responseSchema(type({ name: 'string' }));
    const standard = declared.validator['~standard'];
    const asynchronous = {
      ...declared,
      validator: {
        '~standard': {
          ...standard,
          validate: async (input: unknown) => {
            await Promise.resolve();
            return standard.validate(input);
          },
        },
      },
    };
    expect(await validateSchema(asynchronous, { name: 'Plan' })).toMatchObject({
      value: { name: 'Plan' },
    });
    expect((await validateSchema(asynchronous, { name: 42 })).issues).toBeDefined();
  });
});

test('enforces JSON object semantics for optional-only objects at every nested request boundary', async () => {
  const patch = type({ 'name?': 'string' });
  const shape = requestSchema(type({ patch, rows: patch.array() }));
  for (const body of [
    { patch: [], rows: [] },
    { patch: {}, rows: [[]] },
  ]) {
    const checked = await validateSchema(shape, body);
    expect(checked.issues).toBeDefined();
    expect(checked.issues?.[0]?.path).toEqual(
      'patch' in body && Array.isArray(body.patch) ? ['patch'] : ['rows', 0],
    );
  }
  expect(await validateSchema(shape, { patch: {}, rows: [{}] })).toEqual({
    value: { patch: {}, rows: [{}] },
  });
  const alternatives = requestSchema(
    type({ value: type({ kind: "'object'", 'name?': 'string' }).or('string[]') }),
  );
  expect(await validateSchema(alternatives, { value: [] })).toEqual({ value: { value: [] } });
  expect(await validateSchema(alternatives, { value: { kind: 'object', name: 'x' } })).toEqual({
    value: { value: { kind: 'object', name: 'x' } },
  });
});

test('does not mask a wrong discriminator with another branch containing a valid array', async () => {
  const shape = requestSchema(
    type({ kind: "'edit'", patch: { 'name?': 'string' } }).or({
      kind: "'list'",
      patch: 'string[]',
    }),
  );
  expect((await validateSchema(shape, { kind: 'edit', patch: [] })).issues).toBeDefined();
  expect(await validateSchema(shape, { kind: 'list', patch: [] })).toEqual({
    value: { kind: 'list', patch: [] },
  });
  expect(await validateSchema(shape, { kind: 'edit', patch: {} })).toEqual({
    value: { kind: 'edit', patch: {} },
  });
});

test('maps escaped object keys and array indexes in request descriptor issues', async () => {
  const shape = requestSchema(type({ 'a/b~c': type({ 'name?': 'string' }).array() }));
  const checked = await validateSchema(shape, { 'a/b~c': [[]] });
  expect(checked.issues?.[0]?.path).toEqual(['a/b~c', 0]);
  const missing = await validateSchema(requestSchema(type({ name: 'string' })), {});
  expect(missing.issues?.[0]?.path).toEqual(['name']);
  const extra = await validateSchema(requestSchema(type({ 'name?': 'string' })), { extra: 1 });
  expect(extra.issues?.[0]?.path).toEqual(['extra']);
});

test('throws on malformed trusted descriptor-validator diagnostics', () => {
  for (const [errors, message] of [
    [undefined, 'HTTP descriptor refused without issues'],
    [[{ instancePath: '', keyword: 'type', params: {} }], 'HTTP descriptor issue has no message'],
  ] as const) {
    const validator = Object.assign(() => false, { errors });
    const compile = spyOn(Ajv2020.prototype, 'compile').mockReturnValue(
      validator as unknown as ReturnType<Ajv2020['compile']>,
    );
    try {
      const shape = requestSchema(type({ 'name?': 'string' }));
      expect(() => shape.validator['~standard'].validate({})).toThrow(message);
    } finally {
      compile.mockRestore();
    }
  }
});

test('refuses array-valued optional-only response objects while retaining additive nested fields', async () => {
  const shape = responseSchema(type({ project: { 'name?': 'string' } }));
  expect((await validateSchema(shape, { project: [] })).issues).toBeDefined();
  const reply = { project: { name: 'Known', added: { anything: [] } }, future: true };
  expect(await validateSchema(shape, reply)).toEqual({ value: reply });
});

test('normalizes exact never descriptors without changing neighboring enum constraints', async () => {
  const declaration = type({
    error: "'expected_object'",
    'at?': 'never',
    'kind?': 'never',
    state: "'one' | 'two'",
  });
  const shape = responseSchema(declaration);
  expect(shape.jsonSchema).toMatchObject({
    properties: { at: { not: {} }, kind: { not: {} }, state: { enum: ['one', 'two'] } },
  });
  expect(
    (await validateSchema(shape, { error: 'expected_object', state: 'one', future: true })).issues,
  ).toBeUndefined();
  for (const value of [
    { error: 'expected_object', state: 'one', at: 0 },
    { error: 'expected_object', state: 'one', kind: 'invented' },
    { error: 'expected_object', state: 'three' },
  ])
    expect((await validateSchema(shape, value)).issues).toBeDefined();
});
