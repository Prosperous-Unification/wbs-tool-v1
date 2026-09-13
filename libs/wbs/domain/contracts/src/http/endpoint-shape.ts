import type { Refusal, RefusalStatus } from './refusal';
import type { SchemaShape } from './schema-shape';

export type RequestPolicy =
  | { kind: 'origin'; when: 'always-unsafe-with-session-cookie' | 'always' }
  | { kind: 'identity'; require: 'signed-in' | 'read-scope' | 'write-scope' | 'internal' };

/** Parameter names come from the declared path, including every nested segment. */
export type ParamsOf<Path extends string> = Path extends `${string}:${infer Name}/${infer Tail}`
  ? Record<Name | keyof ParamsOf<Tail>, string>
  : Path extends `${string}:${infer Name}`
    ? Record<Name, string>
    : Record<never, string>;

export interface JsonResponse {
  kind: 'json';
  status: 200 | 201 | 202;
  schema: SchemaShape<unknown>;
}

export interface EmptyResponse {
  kind: 'empty';
  status: 204 | 302;
}

export interface TextResponse {
  kind: 'text';
  status: 200 | 500;
  contentType: string;
}

export interface RefusalResponse {
  status: RefusalStatus;
  schema: SchemaShape<Refusal>;
}

/** A modeled refusal whose wire representation is deliberately bodyless. */
export interface EmptyRefusalResponse {
  kind: 'empty';
  status: RefusalStatus;
}

/**
 * The handler-free HTTP contract shared by adapters, clients and documents.
 * Success variants declare their representation and status together, so JSON
 * null, an empty response, a redirect and plain text cannot be interchanged.
 */
export type BodyMedia =
  'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';

export type QueryMode = 'arbitrary-singleton';

export interface EndpointShape {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/${string}`;
  operationId: string;
  policies: readonly RequestPolicy[];
  params?: SchemaShape<Record<string, string>>;
  query?: SchemaShape<unknown>;
  /** Every arrived key is admitted once; repeated top-level keys are malformed. */
  queryMode?: QueryMode;
  body?: SchemaShape<unknown>;
  // Proof: widening to string[] produced TS2578 for the empty/unknown-media actual declaration fixtures.
  bodyMedia?: readonly [BodyMedia, ...BodyMedia[]];
  responses: readonly (JsonResponse | EmptyResponse | TextResponse)[];
  refusals: readonly (RefusalResponse | EmptyRefusalResponse)[];
  document: { summary: string };
}

/**
 * Proof (type boundary): replacing this with unknown produces TS2578 for the
 * actual shape fixtures that rename, add, or omit a nested path parameter.
 */
type ExactParams<S extends EndpointShape> = S extends { params: SchemaShape<infer P> }
  ? [keyof P] extends [keyof ParamsOf<S['path']>]
    ? [keyof ParamsOf<S['path']>] extends [keyof P]
      ? unknown
      : never
    : never
  : unknown;

/**
 * Consumes a finite path literal; an unresolved template tail is not a route declaration.
 * Proof (type boundary): the former string-extends-path guard admitted `/${string}`,
 * producing TS2578 for the broad-path fixture. Restoring it reproduced that failure.
 */
type IsLiteralPath<Path extends string> = string extends Path
  ? false
  : Path extends ''
    ? true
    : Path extends `${infer Head}${infer Tail}`
      ? string extends Head
        ? false
        : IsLiteralPath<Tail>
      : false;

/**
 * A principal can represent a user or an internal caller, never both in one request.
 * Proof: omitting this constraint makes both ordered mixed-policy actual-shape
 * fixtures report TS2578; the type boundary is backed by the adapter's erased-table check.
 */
type CompatibleIdentity<S extends EndpointShape> =
  Extract<S['policies'][number], { kind: 'identity'; require: 'internal' }> extends never
    ? unknown
    : Extract<
          S['policies'][number],
          { kind: 'identity'; require: 'signed-in' | 'read-scope' | 'write-scope' }
        > extends never
      ? unknown
      : never;

/** Preserves literal policies and statuses while refusing divergent parameter names. */
export function defineEndpointShape<const S extends EndpointShape>(
  shape: S &
    ExactParams<S> &
    CompatibleIdentity<S> &
    // Proof: removing this constraint produced TS2578 for the bodyless-media actual declaration fixture.
    (S extends { bodyMedia: unknown }
      ? S extends { body: SchemaShape<unknown> }
        ? unknown
        : never
      : unknown) &
    (S extends { queryMode: unknown }
      ? S extends { query: SchemaShape<unknown> }
        ? unknown
        : never
      : unknown) &
    (IsLiteralPath<S['path']> extends true ? unknown : never),
): S {
  // Proof: omitting declaration validation made the malformed erased declaration test stop throwing.
  bodyMediaFor(shape);
  queryModeFor(shape);
  return shape;
}

/**
 * Resolves the closed-query default and proves that an open declaration validates
 * every arbitrary value as a string before an adapter collapses the URL entries.
 */
export function queryModeFor(shape: EndpointShape): QueryMode | 'declared' {
  const mode = erasedDeclaration(shape.queryMode);
  if (mode === undefined) return 'declared';
  const descriptor = erasedDeclaration(shape.query?.jsonSchema);
  const objectKeywords = new Set([
    '$schema',
    'type',
    'additionalProperties',
    'title',
    'description',
  ]);
  // Proof: removing these declaration checks made the malformed arbitrary-singleton
  // test return the shape instead of throwing (document-from-shapes.test.ts).
  if (
    mode !== 'arbitrary-singleton' ||
    typeof descriptor !== 'object' ||
    descriptor === null ||
    !('type' in descriptor) ||
    descriptor.type !== 'object' ||
    !('additionalProperties' in descriptor) ||
    typeof descriptor.additionalProperties !== 'object' ||
    descriptor.additionalProperties === null ||
    !('type' in descriptor.additionalProperties) ||
    descriptor.additionalProperties.type !== 'string' ||
    // Proof: omitting this guard made an optional named property return the shape instead of throwing.
    Object.keys(descriptor).some((key) => !objectKeywords.has(key)) ||
    // Proof: omitting this guard made a minLength-constrained value return the shape instead of throwing.
    Object.keys(descriptor.additionalProperties).some((key) => key !== 'type')
  ) {
    throw new Error(`Invalid arbitrary-singleton query declaration: ${shape.operationId}`);
  }
  return mode;
}

/** Reads an erased JavaScript declaration without trusting its TypeScript annotation. */
function erasedDeclaration(value: unknown): unknown {
  return value;
}

/** Resolves the JSON default and refuses malformed trusted declarations at every erased-table consumer. */
export function bodyMediaFor(shape: EndpointShape): readonly BodyMedia[] {
  const media: readonly unknown[] | undefined = shape.bodyMedia;
  if (media === undefined) return shape.body === undefined ? [] : ['application/json'];
  // Proof: independently removing body/nonempty/known-media guards made the mounted and emitted malformed-table tests stop throwing.
  if (
    shape.body === undefined ||
    media.length === 0 ||
    !media.every(
      (entry): entry is BodyMedia =>
        entry === 'application/json' ||
        entry === 'application/x-www-form-urlencoded' ||
        entry === 'multipart/form-data',
    )
  )
    throw new Error(`Invalid body media declaration: ${shape.operationId}`);
  return media;
}
