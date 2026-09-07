import { ClientConfigurationError } from './client-error';
import type {
  Client,
  ClientBoundaryFailure,
  ClientFailure,
  ClientReply,
  ClientTransport,
  PreflightInput,
  TransportInput,
  TransportReply,
} from './client-types';
import type { EndpointShape } from './endpoint-shape';
import { validateSchema } from './schema-shape';

/** Builds independent methods keyed by operationId; response validation precedes every return. */
export function clientFromShapes<const Shapes extends readonly EndpointShape[]>(
  shapes: Shapes,
  transport: ClientTransport,
): Client<Shapes> {
  const methods = new Map<
    string,
    (input: Partial<TransportInput>) => Promise<ClientReply<EndpointShape>>
  >();
  for (const shape of shapes) {
    // Proof: deleting either identifier guard failed its blank/duplicate operation identifier test.
    if (shape.operationId.trim() === '') throw new ClientConfigurationError('Blank operationId');
    if (methods.has(shape.operationId))
      throw new Error(`Duplicate operationId: ${shape.operationId}`);
    methods.set(shape.operationId, (input) => invoke(shape, input, transport));
  }
  // Each method closes over its exact shape, validates its inputs and every response,
  // and operation identifiers are unique. This is the heterogeneous table's type boundary.
  return Object.fromEntries(methods) as unknown as Client<Shapes>;
}

function failed(failure: ClientFailure): ClientBoundaryFailure {
  return { kind: 'failure', failure };
}

export type RequestPreflight<Shape extends EndpointShape> =
  | { kind: 'ready'; input: PreflightInput<Shape> }
  | ClientBoundaryFailure;

/**
 * Normalizes and validates one request before transport. Synchronous schemas
 * complete in the calling stack; an asynchronous schema returns a promise and
 * resumes the same ordered preflight when it settles.
 */
export function preflightRequest<const Shape extends EndpointShape>(
  shape: Shape,
  supplied: Partial<TransportInput>,
): RequestPreflight<Shape> | Promise<RequestPreflight<Shape>> {
  // Proof: removing cancellation guards failed already-aborted and held-validation cases (transport invoked unexpectedly).
  if (supplied.signal?.aborted) return failed({ code: 'cancelled' });
  const input: TransportInput = {
    ...supplied,
    params: supplied.params ?? {},
    query: supplied.query,
    body: supplied.body,
  };
  if (
    input.query !== undefined &&
    typeof input.query === 'object' &&
    input.query !== null &&
    !Array.isArray(input.query)
  ) {
    input.query = Object.fromEntries(
      Object.entries(input.query).filter(([, value]) => value !== undefined),
    );
  }
  if (input.body !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = serializeBody(input.body);
    } catch (cause) {
      // Proof: broadening this catch failed 'reports non-JSON client bodies ... unexpected serialization failures'.
      if (!(cause instanceof TypeError)) throw cause;
      return failed({ code: 'invalid_request', part: 'body' });
    }
    // Proof: removing this guard made the non-JSON client bodies case throw during decoding.
    if (serialized === undefined) return failed({ code: 'invalid_request', part: 'body' });
    // Proof: omitting normalization failed optional undefined body fields: expected success, received failure.
    input.body = JSON.parse(serialized);
  }
  // Proof: bypassing exact key count failed 'refuses missing, extra and URL dot-segment params before transport'.
  const names = shape.path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  if (
    Object.keys(input.params).length !== names.length ||
    names.some(
      (name) =>
        typeof input.params[name] !== 'string' ||
        input.params[name] === '' ||
        input.params[name] === '.' ||
        input.params[name] === '..',
    )
  )
    return failed({ code: 'invalid_request', part: 'params' });
  return validateRequestParts(shape, input, 0);
}

const REQUEST_PARTS = ['params', 'query', 'body'] as const;

/** Continues synchronously until the next asynchronous validator, if any. */
function validateRequestParts<Shape extends EndpointShape>(
  shape: Shape,
  input: TransportInput,
  index: number,
): RequestPreflight<Shape> | Promise<RequestPreflight<Shape>> {
  const part = REQUEST_PARTS.at(index);
  if (part === undefined) {
    if (input.signal?.aborted) return failed({ code: 'cancelled' });
    // Exact path checks plus every declared request schema establish this
    // shape-derived type; request declarations forbid transforms and defaults.
    return { kind: 'ready', input: input as PreflightInput<Shape> };
  }
  const schema = shape[part];
  if (schema === undefined) {
    if (part !== 'params' && input[part] !== undefined)
      return failed({ code: 'invalid_request', part });
    return validateRequestParts(shape, input, index + 1);
  }
  const value = part === 'query' && input.query === undefined ? {} : input[part];
  const validation = schema.validator['~standard'].validate(value);
  if (isPromiseLike(validation))
    return Promise.resolve(validation).then((completed) => {
      // Proof: bypassing request issues failed 'validates request input before invoking transport and does not share calls'.
      if (completed.issues !== undefined) return failed({ code: 'invalid_request', part });
      // Proof: discarding this value made the async forwarding test receive
      // `{ name: 'Plan', ignored: 'future-field' }` instead of `{ name: 'Plan' }`.
      if (part !== 'params') input[part] = completed.value;
      return validateRequestParts(shape, input, index + 1);
    });
  // Proof: bypassing request issues failed 'validates request input before invoking transport and does not share calls'.
  if (validation.issues !== undefined) return failed({ code: 'invalid_request', part });
  // Proof: discarding this value made the Retry transport receive the
  // undeclared `ignored: 'future-field'` property.
  if (part !== 'params') input[part] = validation.value;
  return validateRequestParts(shape, input, index + 1);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

/** Keeps unexpected synchronous preflight faults on the Promise-returning client contract. */
function rejectInvoke(cause: unknown): Promise<never> {
  return Promise.resolve().then(() => {
    throw cause;
  });
}

function invoke(
  shape: EndpointShape,
  supplied: Partial<TransportInput>,
  transport: ClientTransport,
): Promise<ClientReply<EndpointShape>> {
  let preflight: RequestPreflight<EndpointShape> | Promise<RequestPreflight<EndpointShape>>;
  try {
    preflight = preflightRequest(shape, supplied);
  } catch (cause) {
    return rejectInvoke(cause);
  }
  if (isPromiseLike(preflight))
    return Promise.resolve(preflight).then((completed) =>
      invokeAfterPreflight(shape, supplied, transport, completed),
    );
  // Proof: unconditionally awaiting this synchronous value made the production
  // WBS client test expect two fetch calls and receive zero in the calling stack.
  return invokeAfterPreflight(shape, supplied, transport, preflight);
}

async function invokeAfterPreflight(
  shape: EndpointShape,
  supplied: Partial<TransportInput>,
  transport: ClientTransport,
  preflight: RequestPreflight<EndpointShape>,
): Promise<ClientReply<EndpointShape>> {
  if (preflight.kind === 'failure') return preflight;
  const { input } = preflight;
  let response: Response | TransportReply;
  try {
    response = await transport(shape, input);
  } catch (cause) {
    // Proof: swallowing this error failed both corrupted transport input and unrepresentable query declaration cases.
    if (cause instanceof ClientConfigurationError) throw cause;
    if (supplied.signal?.aborted) return failed({ code: 'cancelled' });
    return failed({ code: 'transport', cause });
  }
  if (supplied.signal?.aborted) {
    await discard(response);
    return failed({ code: 'cancelled' });
  }
  const headers = new Headers(response.headers);
  const status = response.status;
  if (
    !shape.responses.some((candidate) => candidate.status === status) &&
    !shape.refusals.some((candidate) => candidate.status === status)
  ) {
    await discard(response);
    return failed({ code: 'unexpected_status', status, headers });
  }
  let reply: TransportReply;
  if (response instanceof Response) {
    let source: string;
    try {
      source = await response.text();
    } catch (cause) {
      return failed(
        supplied.signal?.aborted ? { code: 'cancelled' } : { code: 'transport', cause },
      );
    }
    if (supplied.signal?.aborted) return failed({ code: 'cancelled' });
    // Proof: checking empty successes only made the real Response test return
    // invalid_response/json at 503 instead of a bodyless refusal.
    if (
      (shape.responses.some(
        (candidate) => candidate.status === status && candidate.kind === 'empty',
      ) ||
        shape.refusals.some((candidate) => candidate.status === status && 'kind' in candidate)) &&
      source === ''
    ) {
      reply = { kind: 'empty', status, headers };
    } else if (
      shape.responses.some(
        (candidate) =>
          candidate.status === status &&
          candidate.kind === 'text' &&
          headers.get('content-type') === candidate.contentType,
      )
    ) {
      reply = { kind: 'text', text: source, status, headers };
    } else {
      try {
        reply = { kind: 'json', status, headers, body: JSON.parse(source) };
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        return failed({ code: 'invalid_response', reason: 'json', status, headers });
      }
    }
  } else reply = response;
  let applicable = false;
  if (reply.kind === 'json') {
    // Proof: first-only alternatives failed the later same-status async refusal; removing status matching admitted a mismatched pair.
    for (const refusal of shape.refusals) {
      if (refusal.status !== status) continue;
      applicable = true;
      if ('kind' in refusal) continue;
      // Proof: bypassing validation failed malformed 429/503/501 refusals and recognized-code malformed 501 details.
      const checked = await validateSchema(refusal.schema, reply.body);
      if (supplied.signal?.aborted) return failed({ code: 'cancelled' });
      if (checked.issues === undefined)
        return {
          kind: 'refusal',
          representation: 'json',
          status: refusal.status,
          body: checked.value,
          headers,
        };
    }
  }
  if (reply.kind === 'empty') {
    for (const refusal of shape.refusals) {
      if (refusal.status !== status || !('kind' in refusal)) continue;
      return {
        kind: 'refusal',
        representation: 'empty',
        status: refusal.status,
        headers,
      };
    }
  }
  // Proof: first-only alternatives failed later JSON/null/text/empty responses: expected success, received failure.
  for (const success of shape.responses) {
    if (success.status !== status || success.kind !== reply.kind) continue;
    applicable = true;
    if (success.kind === 'empty' && reply.kind === 'empty')
      return { kind: 'success', representation: 'empty', status: success.status, headers };
    // Proof: removing the text type guard admitted malformed normalized text in its production client test.
    if (success.kind === 'text' && reply.kind === 'text' && typeof reply.text === 'string')
      return {
        kind: 'success',
        representation: 'text',
        status: success.status,
        text: reply.text,
        headers,
      };
    if (success.kind === 'json' && reply.kind === 'json') {
      // Proof: removing the envelope guard failed the permissive-success-schema refusal test.
      if (reply.body !== null && typeof reply.body === 'object' && 'error' in reply.body) continue;
      // Proof: bypassing validation admitted the backend-only known-field type change; removing await failed async validation.
      const checked = await validateSchema(success.schema, reply.body);
      if (supplied.signal?.aborted) return failed({ code: 'cancelled' });
      if (checked.issues === undefined)
        return {
          kind: 'success',
          representation: 'json',
          status: success.status,
          body: checked.value,
          headers,
        };
    }
  }
  return failed({
    code: 'invalid_response',
    reason: applicable ? 'schema' : 'representation',
    status,
    headers,
  });
}

/** A Fetch body not consumed by decoding must be canceled before completing the call. */
async function discard(response: Response | TransportReply): Promise<void> {
  // Proof: removing cancellation failed unread-body cleanup (expected true, received false) and cleanup-error propagation.
  if (response instanceof Response && response.body !== null) await response.body.cancel();
}

/** JSON.stringify can return undefined for a root symbol/function, despite its library signature. */
function serializeBody(body: unknown): string | undefined {
  return JSON.stringify(body);
}
