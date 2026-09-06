import { type } from 'arktype';
import { describe, expect, test } from 'bun:test';

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
