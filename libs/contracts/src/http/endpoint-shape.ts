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
  status: 200 | 201;
  schema: SchemaShape<unknown>;
}

export interface EmptyResponse {
  kind: 'empty';
  status: 204 | 302;
}

export interface TextResponse {
  kind: 'text';
  status: 200;
  contentType: string;
}

export interface RefusalResponse {
  status: RefusalStatus;
  schema: SchemaShape<Refusal>;
}

/**
 * The handler-free HTTP contract shared by adapters, clients and documents.
 * Success variants declare their representation and status together, so JSON
 * null, an empty response, a redirect and plain text cannot be interchanged.
 */
export interface EndpointShape {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/${string}`;
  operationId: string;
  policies: readonly RequestPolicy[];
  params?: SchemaShape<Record<string, string>>;
  query?: SchemaShape<unknown>;
  body?: SchemaShape<unknown>;
  responses: readonly (JsonResponse | EmptyResponse | TextResponse)[];
  refusals: readonly RefusalResponse[];
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
    (IsLiteralPath<S['path']> extends true ? unknown : never),
): S {
  return shape;
}
