import type { EndpointShape, ParamsOf } from './endpoint-shape';
import type { SchemaShape } from './schema-shape';

/** Header inputs available in both browser and Bun TypeScript libraries. */
export type HttpHeaders = Headers | Record<string, string> | [string, string][];

// Proof: widening params/query/body to records produced TS2578 in actual client call fixtures at lines 54/56/60.
type Parameters<S extends EndpointShape> = keyof ParamsOf<S['path']> extends never
  ? { params?: never }
  : { params: ParamsOf<S['path']> };
type Query<S extends EndpointShape> = S extends { query: SchemaShape<infer Q> }
  ? Record<never, never> extends Q
    ? { query?: Q }
    : { query: Q }
  : { query?: never };
type Body<S extends EndpointShape> = S extends { body: SchemaShape<infer B> }
  ? { body: B }
  : { body?: never };

/** A browser supplies wire inputs and cancellation, never an application principal. */
export type ClientInput<S extends EndpointShape> = Parameters<S> &
  Query<S> &
  Body<S> & {
    headers?: HttpHeaders;
    signal?: AbortSignal;
  };

/** The normalized request passed to either transport, after declared input validation. */
export interface TransportInput {
  params: Record<string, string | undefined>;
  query: unknown;
  body: unknown;
  headers?: HttpHeaders;
  signal?: AbortSignal;
}

type PreparedQuery<S extends EndpointShape> = S extends { query: SchemaShape<infer Q> }
  ? Q | undefined
  : undefined;
type PreparedBody<S extends EndpointShape> = S extends { body: SchemaShape<infer B> }
  ? B
  : undefined;

/** A request after the shape's exact runtime boundary has accepted and normalized it. */
export type PreflightInput<S extends EndpointShape> = Omit<
  TransportInput,
  'params' | 'query' | 'body'
> & {
  params: ParamsOf<S['path']>;
  query: PreparedQuery<S>;
  body: PreparedBody<S>;
};

/** Explicit representations let an in-process adapter translate its own empty sentinel. */
export type TransportReply = { status: number; headers?: HttpHeaders } & (
  | { kind: 'json'; body: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
);

/** Fetch and in-process transports share response validation, without a backend import. */
export type ClientTransport = (
  shape: EndpointShape,
  input: TransportInput,
) => Promise<Response | TransportReply>;

/** A failure at the client boundary is distinct from a validated application refusal. */
export type ClientFailure =
  | { code: 'cancelled' }
  | { code: 'transport'; cause: unknown }
  | { code: 'invalid_request'; part: 'params' | 'query' | 'body' }
  | { code: 'unexpected_status'; status: number; headers: Headers }
  | {
      code: 'invalid_response';
      reason: 'json' | 'schema' | 'representation';
      status: number;
      headers: Headers;
    };

export interface ClientBoundaryFailure {
  kind: 'failure';
  failure: ClientFailure;
}

// Proof: widening success fields produced TS2578 at fixture line 69; collapsing refusal distribution produced TS2578 at line 93.
type Success<R> = R extends { kind: 'json'; status: infer S; schema: SchemaShape<infer T> }
  ? { kind: 'success'; representation: 'json'; status: S; body: T; headers: Headers }
  : R extends { kind: 'text'; status: infer S }
    ? { kind: 'success'; representation: 'text'; status: S; text: string; headers: Headers }
    : R extends { kind: 'empty'; status: infer S }
      ? { kind: 'success'; representation: 'empty'; status: S; headers: Headers }
      : never;
type Refused<R> = R extends { kind: 'empty'; status: infer S }
  ? { kind: 'refusal'; representation: 'empty'; status: S; headers: Headers }
  : R extends { status: infer S; schema: SchemaShape<infer T> }
    ? { kind: 'refusal'; representation: 'json'; status: S; body: T; headers: Headers }
    : never;

/** Status and representation remain paired with their own schema's inferred output. */
export type ClientReply<S extends EndpointShape> =
  | Success<S['responses'][number]>
  | Refused<S['refusals'][number]>
  | ClientBoundaryFailure;

export type Client<Shapes extends readonly EndpointShape[]> = {
  [S in Shapes[number] as S['operationId']]: (input: ClientInput<S>) => Promise<ClientReply<S>>;
};
