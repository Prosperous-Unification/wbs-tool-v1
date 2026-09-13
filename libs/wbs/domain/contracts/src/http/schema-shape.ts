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

interface RequestSchemaOptions {
  undeclaredKeys?: 'reject' | 'delete';
}

/** Declares a closed request, with explicit deletion only for established tolerant contracts. */
export function requestSchema<S extends Type>(
  declaration: S,
  options: RequestSchemaOptions = {},
): SchemaShape<S['infer']> {
  const undeclaredKeys = options.undeclaredKeys ?? 'reject';
  if (undeclaredKeys === 'delete') {
    // Validate the caller's declaration before adding the one projection this
    // boundary owns; other transforms and defaults remain unsupported.
    declareSchema(declaration);
  }
  const shape =
    undeclaredKeys === 'delete'
      ? schemaOf(declaration.onDeepUndeclaredKey('delete'))
      : declareSchema(declaration.onDeepUndeclaredKey('reject'));
  return undeclaredKeys === 'delete' ? checkedNormalizedSchema(shape) : checkedSchema(shape);
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
          const issues = descriptorIssues(validates, value);
          if (issues !== undefined) return { issues };
          return standard.validate(value);
        },
      },
    },
  };
}

/** Runs a deleting validator before checking the precise value delivered inside the boundary. */
function checkedNormalizedSchema<T>(shape: SchemaShape<T>): SchemaShape<T> {
  const validates = descriptors.compile(shape.jsonSchema);
  const standard = shape.validator['~standard'];
  const complete = (checked: StandardSchemaV1.Result<T>): StandardSchemaV1.Result<T> => {
    if (checked.issues !== undefined) return checked;
    const issues = descriptorIssues(validates, checked.value);
    return issues === undefined ? checked : { issues };
  };
  return {
    ...shape,
    validator: {
      '~standard': {
        ...standard,
        validate(value: unknown) {
          const checked = standard.validate(value);
          return isPromiseLike(checked)
            ? Promise.resolve(checked).then(complete)
            : complete(checked);
        },
      },
    },
  };
}

function descriptorIssues(
  validates: ReturnType<Ajv2020['compile']>,
  value: unknown,
): StandardSchemaV1.Issue[] | undefined {
  if (validates(value)) return undefined;
  const errors = validates.errors;
  // Proof: deleting this guard changed the malformed-diagnostics test's expected contextual exception.
  if (errors === null || errors === undefined)
    throw new Error('HTTP descriptor refused without issues');
  return errors.map((error) => descriptorIssue(error, value));
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
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
  const shape = schemaOf(declaration);
  const input = declaration.in.toJsonSchema();
  const output = declaration.out.toJsonSchema();
  if (JSON.stringify(input) !== JSON.stringify(output)) {
    throw new Error('HTTP wire schemas must have identical input and output contracts');
  }
  return shape;
}

function schemaOf<S extends Type>(declaration: S): SchemaShape<S['infer']> {
  const jsonSchema = declaration.toJsonSchema();
  // Proof: omitting this call reached emission (expected false, received true)
  // in MCP's recursive-declaration publication test (shape-document.test.ts).
  assertInlineSchema(jsonSchema);
  return { validator: declaration, jsonSchema: normalizeNever(jsonSchema) };
}

/**
 * Ark emits optional never fields as enum:[], which JSON Schema forbids. The
 * equivalent not:{} remains an object schema in Ark's public descriptor type.
 * Proof: bypassing normalization threw enum must have non-empty array in the
 * focused never-descriptor test. Normalizing nonempty enums changed its
 * neighboring state enum and failed the descriptor assertion.
 * Only schema-valued positions are visited; annotations and literal values are
 * untouched, and only the exact empty-enum object is rewritten.
 */
function normalizeNever(schema: JsonSchema): JsonSchema {
  if ('enum' in schema && schema.enum.length === 0 && Object.keys(schema).length === 1)
    return { not: {} };
  const normalized = { ...schema };
  if ('properties' in normalized && normalized.properties !== undefined)
    normalized.properties = normalizeProperties(normalized.properties);
  if ('patternProperties' in normalized && normalized.patternProperties !== undefined)
    normalized.patternProperties = normalizeProperties(normalized.patternProperties);
  if ('anyOf' in normalized) normalized.anyOf = normalized.anyOf.map(normalizeNever);
  if ('oneOf' in normalized) normalized.oneOf = normalized.oneOf.map(normalizeNever);
  if ('allOf' in normalized) normalized.allOf = normalized.allOf.map(normalizeNever);
  if ('not' in normalized) normalized.not = normalizeNever(normalized.not);
  if ('items' in normalized && normalized.items !== undefined)
    normalized.items = normalizeBranches(normalized.items);
  if ('prefixItems' in normalized && normalized.prefixItems !== undefined)
    normalized.prefixItems = normalized.prefixItems.map(normalizeBranch);
  if ('contains' in normalized && normalized.contains !== undefined)
    normalized.contains = normalizeBranches(normalized.contains);
  if ('additionalItems' in normalized && normalized.additionalItems !== undefined)
    normalized.additionalItems = normalizeBranches(normalized.additionalItems);
  if ('additionalProperties' in normalized && normalized.additionalProperties !== undefined)
    normalized.additionalProperties = normalizeBranches(normalized.additionalProperties);
  return normalized;
}

/** Preserves property names while normalizing only their schema values. */
function normalizeProperties(properties: Record<string, JsonSchema>): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, normalizeNever(schema)]),
  );
}

/** Array keywords may hold one branch, a tuple, or a boolean schema. */
function normalizeBranches(
  branches: JsonSchema.Branch | readonly JsonSchema.Branch[],
): JsonSchema.Branch | JsonSchema.Branch[] {
  if (isBranchList(branches)) return branches.map(normalizeBranch);
  return normalizeBranch(branches);
}

/** Narrows the descriptor's readonly tuple using the runtime array identity. */
function isBranchList(
  branches: JsonSchema.Branch | readonly JsonSchema.Branch[],
): branches is readonly JsonSchema.Branch[] {
  return Array.isArray(branches);
}

/** Boolean schemas already express their intended truth value. */
function normalizeBranch(branch: JsonSchema.Branch): JsonSchema.Branch {
  return typeof branch === 'boolean' ? branch : normalizeNever(branch);
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
