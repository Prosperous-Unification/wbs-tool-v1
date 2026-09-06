import type { StandardSchemaV1 } from '@ark/schema';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020';
import type { JsonSchema, Type } from 'arktype';

/**
 * One wire declaration, represented for validation and document emission.
 * The descriptor is generated at the ArkType boundary; consumers need only
 * Standard Schema and JSON Schema, never validator-specific introspection.
 * Descriptors must be inline: recursive/reference-based wire schemas are not
 * supported by the initial OpenAPI/MCP property extraction contract.
 */
export interface SchemaShape<T> {
  validator: StandardSchemaV1<unknown, T>;
  jsonSchema: JsonSchema;
}

/** Declares a request without accepting or stripping undeclared nested fields. */
export function requestSchema<S extends Type>(declaration: S): SchemaShape<S['infer']> {
  return checkedSchema(declareSchema(declaration.onDeepUndeclaredKey('reject')));
}

/**
 * ArkType's optional-only object accepts arrays even though its descriptor says
 * JSON object. Compiling that descriptor closes the gap for requests and replies,
 * including union selection, without maintaining a second partial validator.
 * Standard Schema still owns the inferred output and may validate asynchronously.
 * Proof: bypassing descriptor validation admitted the mounted patch:[] and wrong-
 * discriminator cases; bypassing it only for replies admitted the optional-object response.
 */
function checkedSchema<T>(shape: SchemaShape<T>): SchemaShape<T> {
  const validates = descriptors.compile(shape.jsonSchema);
  const standard = shape.validator['~standard'];
  return {
    ...shape,
    validator: {
      '~standard': {
        ...standard,
        validate(value: unknown) {
          if (!validates(value)) {
            const errors = validates.errors;
            // Proof: deleting this guard changed the malformed-diagnostics test's expected contextual exception.
            if (errors === null || errors === undefined)
              throw new Error('HTTP descriptor refused without issues');
            return { issues: errors.map((error) => descriptorIssue(error, value)) };
          }
          return standard.validate(value);
        },
      },
    },
  };
}

/** Declares a reply that remains readable when a newer server adds fields. */
export function responseSchema<S extends Type>(declaration: S): SchemaShape<S['infer']> {
  return checkedSchema(declareSchema(declaration.onDeepUndeclaredKey('ignore')));
}

/**
 * Rejects transforms/defaults and unsupported conversions at declaration time.
 * A projected morph output can be unconstrained even when conversion succeeds;
 * direct conversion and identical generated input/output descriptors prevent
 * that mismatch. Both descriptors use the same converter and property order.
 */
function declareSchema<S extends Type>(declaration: S): SchemaShape<S['infer']> {
  const jsonSchema = declaration.toJsonSchema();
  // Proof: omitting this call reached emission (expected false, received true)
  // in MCP's recursive-declaration publication test (shape-document.test.ts).
  assertInlineSchema(jsonSchema);
  const input = declaration.in.toJsonSchema();
  const output = declaration.out.toJsonSchema();
  if (JSON.stringify(input) !== JSON.stringify(output)) {
    throw new Error('HTTP wire schemas must have identical input and output contracts');
  }
  return { validator: declaration, jsonSchema };
}

/**
 * Refuses references whose definition context would change when an emitter embeds
 * a schema or MCP extracts its properties. Walks only schema-valued keywords in
 * the supported JsonSchema subset; property names and literal annotations are
 * values, so a field named `$ref` or a const object containing it is valid.
 * This is a representability check, not another JSON Schema validator.
 */
export function assertInlineSchema(schema: JsonSchema): void {
  visitSchema(schema);
}

/** Keyword dispatch preserves literal values while following schema applicators. */
function visitSchema(schema: unknown): void {
  if (Array.isArray(schema)) {
    // Proof: skipping branches made the schema-keyword emitter test return a
    // document instead of refusing its anyOf reference (document-from-shapes.test.ts).
    for (const branch of schema) visitSchema(branch);
    return;
  }
  if (typeof schema !== 'object' || schema === null) return;
  const keywords: [string, unknown][] = Object.entries(schema);
  for (const [keyword, value] of keywords) {
    switch (keyword) {
      case '$ref':
        throw new Error('HTTP wire schemas must be inline; references are unsupported');
      case '$defs':
      case 'properties':
      case 'patternProperties':
        // These keywords are schema maps in the typed descriptor boundary.
        // Proof: skipping map children published an unresolved tree input in
        // MCP's structural-descriptor refusal test (shape-document.test.ts).
        if (typeof value === 'object' && value !== null)
          for (const child of Object.values(value)) visitSchema(child);
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
      case 'not':
      case 'items':
      case 'prefixItems':
      case 'additionalItems':
      case 'contains':
      case 'additionalProperties':
      case 'propertyNames':
        visitSchema(value);
    }
  }
}

/** Awaits the standard validation contract, including asynchronous validators. */
export async function validateSchema<T>(
  shape: SchemaShape<T>,
  input: unknown,
): Promise<StandardSchemaV1.Result<T>> {
  return await shape.validator['~standard'].validate(input);
}

/** HTTP descriptors are compiled once at declaration time, without mutation or coercion. */
const descriptors = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });

/** Translates JSON Pointer tokens to Standard Schema paths, retaining numeric array indexes. */
function descriptorIssue(error: ErrorObject, supplied: unknown): StandardSchemaV1.Issue {
  // Proof: removing this guard made the malformed-diagnostics case return instead of throwing.
  if (error.message === undefined) throw new Error('HTTP descriptor issue has no message');
  const path: (string | number)[] = [];
  let current = supplied;
  for (const token of error.instancePath.split('/').slice(1)) {
    // Proof: raw pointer tokens and string array indexes independently failed the escaped-key/index path test.
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    path.push(Array.isArray(current) ? Number(key) : key);
    current =
      typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined;
  }
  const property: unknown =
    error.keyword === 'required'
      ? error.params['missingProperty']
      : error.keyword === 'additionalProperties'
        ? error.params['additionalProperty']
        : undefined;
  // Proof: omitting the property suffix failed the missing/additional property path assertions.
  if (typeof property === 'string') path.push(property);
  return { message: error.message, path };
}
