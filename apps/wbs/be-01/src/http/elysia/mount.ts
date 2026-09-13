import {
  type BodyMedia,
  bodyMediaFor,
  type EndpointShape,
  queryModeFor,
  type Refusal,
  type SchemaShape,
  validateSchema,
} from '@wbs/contracts';
import { Elysia } from 'elysia';

import { hasInvalidCookieOrigin } from '../../middleware/authenticated';
import {
  type BoundEndpoint,
  EMPTY,
  type EndpointReply,
  type Identity,
  type IdentityResolver,
  type RequestFailure,
  type RequestMetadata,
} from '../endpoint';
import { matchPath } from '../route';
import { decodeForm } from './form';

interface MountOptions {
  appOrigin: string;
  resolveIdentity: IdentityResolver;
}

interface Admission {
  endpoint: BoundEndpoint;
  params: Record<string, string>;
  request: RequestMetadata;
  principal?: Identity;
}

/**
 * Mounts policies before parsing and validates both sides of the endpoint boundary.
 * Metadata preserves the arrived method and the raw URL, including duplicate
 * query parameters. A closed query reads the legacy last-value record; an
 * arbitrary-singleton query refuses repeated raw keys before validating the
 * collapsed string record. Undeclared query fields and bodies are refused.
 * Proof: eager JSON decoding before policies makes the malformed read-token test
 * receive 400 instead of 403. Reversing policies makes the declared-order test
 * receive 401 instead of 403; deleting principal delivery makes it receive 500 instead of 200.
 */
export function mountEndpoints(endpoints: readonly BoundEndpoint[], options: MountOptions): Elysia {
  for (const { shape } of endpoints) {
    // Proof: omitting this call made the malformed erased media table mount without throwing.
    bodyMediaFor(shape);
    // Proof: omitting this call made the malformed erased open-query table mount without throwing.
    queryModeFor(shape);
    const internal = shape.policies.some(
      (policy) => policy.kind === 'identity' && policy.require === 'internal',
    );
    const user = shape.policies.some(
      (policy) => policy.kind === 'identity' && policy.require !== 'internal',
    );
    // Proof: removing this check makes the mixed erased-table test fail: function did not throw.
    if (internal && user)
      throw new Error(`Endpoint ${shape.operationId} has incompatible identity policies`);
  }
  const admissions = new WeakMap<Request, Admission>();
  const app = new Elysia();
  // Elysia exports onRequest hooks into a parent before routing, so their error
  // hook must follow them. Limit it to this adapter's selected requests.
  // Proof: local scope gives the composed-app outage test 200 instead of 500;
  // deleting isolation changes the unrelated legacy parser from 400 to 500.
  app.onError({ as: 'global' }, ({ request }) => {
    if (!admissions.has(request)) return undefined;
    return new Response('Internal Server Error', { status: 500 });
  });
  app.onRequest(async ({ request }) => {
    const metadata = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
    };
    const matched = endpoints
      .filter(
        ({ shape }) =>
          shape.method === request.method || (request.method === 'HEAD' && shape.method === 'GET'),
      )
      .flatMap((endpoint) => {
        const params = matchPath(endpoint.shape.path, metadata.url.pathname);
        return params === null ? [] : [{ endpoint, params }];
      })
      .sort((left, right) => comparePaths(left.endpoint.shape.path, right.endpoint.shape.path))
      .at(0);
    if (matched === undefined) return undefined;
    const admission: Admission = {
      endpoint: matched.endpoint,
      params: matched.params,
      request: metadata,
    };
    admissions.set(request, admission);
    for (const policy of matched.endpoint.shape.policies) {
      if (policy.kind === 'origin') {
        const invalid =
          policy.when === 'always'
            ? request.headers.get('origin') !== options.appOrigin
            : hasInvalidCookieOrigin(request, options.appOrigin);
        // Proof: deleting this refusal gives the cookie-origin test 400 instead
        // of 403, and the login-style origin test 200 instead of 403.
        if (invalid) return refuse(matched.endpoint.shape, { error: 'invalid_origin' });
      } else {
        const identity = await options.resolveIdentity(policy.require, metadata);
        if (!identity.ok) return renderReply(matched.endpoint.shape, identity);
        // Proof: deleting this check admits the mismatched-resolver fixture with 200 instead of 500.
        if ((policy.require === 'internal') !== 'kind' in identity.principal) {
          throw new Error('Identity resolver returned the wrong principal kind');
        }
        admission.principal = identity.principal;
      }
    }
    return undefined;
  });
  for (const endpoint of endpoints) {
    app.route(
      endpoint.shape.method,
      endpoint.shape.path,
      async ({ request }) => {
        const admission = admissions.get(request);
        // Proof: removing this check lets the conflicting second binding run (200 instead of 500).
        if (admission?.endpoint !== endpoint) {
          throw new Error('Endpoint dispatch has no matching policy admission');
        }
        // Proof: omitting or moving this after validation changes the callback HEAD
        // from 405 to 400; moving it before policies changes anonymous HEAD from 401 to 405.
        if (endpoint.prevalidate !== undefined) {
          const refusal = await endpoint.prevalidate(admission.request);
          if (refusal !== null) return renderRequestRefusal(endpoint.shape, refusal);
        }
        const params = await validateRequest(endpoint.shape.params, admission.params);
        // Proof: removing params refusal changes the constrained-param test from 422 to 500.
        if (!params.ok)
          return classifyFailure(endpoint, {
            part: 'params',
            code: 'invalid_params',
            rejected: admission.params,
            issues: params.issues,
            request: admission.request,
          });
        // Proof: removing this check admits the undeclared-query fixture (200 instead of 400).
        if (endpoint.shape.query === undefined && admission.request.url.searchParams.size > 0) {
          return classifyFailure(endpoint, {
            part: 'query',
            code: 'invalid_query',
            rejected: Object.fromEntries(admission.request.url.searchParams),
            request: admission.request,
          });
        }
        const collapsedQuery = Object.fromEntries(admission.request.url.searchParams);
        if (endpoint.shape.queryMode === 'arbitrary-singleton') {
          const names = new Set<string>();
          for (const name of admission.request.url.searchParams.keys()) {
            // Proof: removing this raw-cardinality check made the open-query
            // test receive 200 instead of 400 and invoked the handler twice.
            if (names.has(name))
              return classifyFailure(endpoint, {
                part: 'query',
                code: 'invalid_query',
                duplicate: name,
                rejected: collapsedQuery,
                request: admission.request,
              });
            names.add(name);
          }
        }
        const query = await validateRequest(endpoint.shape.query, collapsedQuery);
        // Proof: removing query refusal admits the metadata test's extra key (200 instead of 400).
        if (!query.ok)
          return classifyFailure(endpoint, {
            part: 'query',
            code: 'invalid_query',
            rejected: collapsedQuery,
            issues: query.issues,
            request: admission.request,
          });
        // Proof: removing presence refusal failed absent-versus-empty form/JSON before the handler-call control.
        if (endpoint.shape.body !== undefined && request.body === null)
          return classifyFailure(endpoint, {
            part: 'body',
            code: 'invalid_body',
            rejected: undefined,
            request: admission.request,
          });
        let decoded: unknown;
        // Read outside the multipart syntax catch so an unreadable stream stays an infrastructure failure.
        const hasUnreadableBody = hasUnreadableBodyFraming(request);
        const bytes =
          request.method === 'GET' || request.method === 'HEAD'
            ? new ArrayBuffer(0)
            : await request.arrayBuffer();
        const source = new TextDecoder().decode(bytes);
        // Proof: deleting hasUnreadableBody from this condition made the real
        // production /health TCP test receive six 200s instead of six 400s for
        // GET/HEAD length, nonempty-chunked and zero-chunk body framing.
        // Proof: deleting source from this condition admits every nonempty
        // undeclared POST body (200 instead of 400).
        if (endpoint.shape.body === undefined && (hasUnreadableBody || source !== '')) {
          return classifyFailure(endpoint, {
            part: 'body',
            code: 'invalid_body',
            rejected: source,
            request: admission.request,
          });
        }
        if (endpoint.shape.body !== undefined) {
          const contentType = request.headers.get('content-type') ?? '';
          const mediaType = parserMedia(contentType);
          // Proof: replacing parserMedia with normalized exact matching made the
          // migrated project media cases return422 instead of200 for both
          // application/json-patch+json and application/xml.
          // Proof: admitting octet-stream bytes as an empty object made the binary
          // project patch test receive200 instead of422.
          // Proof: removing media selection admitted valid JSON under missing/unsupported media (200 instead of 400).
          if (!bodyMediaFor(endpoint.shape).some((media) => media === mediaType))
            return classifyFailure(endpoint, {
              part: 'body',
              code: 'invalid_body',
              rejected: source,
              request: admission.request,
            });
          // Proof: disabling form decoding made the mounted valid-form test return 400 instead of 200.
          if (
            mediaType === 'application/x-www-form-urlencoded' ||
            mediaType === 'multipart/form-data'
          ) {
            const form = await decodeForm(bytes, contentType, mediaType);
            if (!form.ok)
              return classifyFailure(endpoint, {
                part: 'body',
                code: 'invalid_body',
                rejected: source,
                request: admission.request,
              });
            decoded = form.fields;
          } else {
            try {
              // Proof: skipping empty JSON parsing changed invalid_json to invalid_body in the required-body test.
              decoded = JSON.parse(source);
            } catch (error) {
              // Proof: broadening this catch maps the injected decoder outage to 400 instead of 500.
              if (!(error instanceof SyntaxError)) throw error;
              return classifyFailure(endpoint, {
                part: 'body',
                code: 'invalid_json',
                rejected: source,
                request: admission.request,
              });
            }
          }
        }
        const body = await validateRequest(endpoint.shape.body, decoded);
        // Proof: removing body refusal changes the nested-extra-field test from 400 to 500.
        if (!body.ok)
          return classifyFailure(endpoint, {
            part: 'body',
            code: 'invalid_body',
            rejected: decoded,
            issues: body.issues,
            request: admission.request,
          });
        const input = {
          request: admission.request,
          params: endpoint.shape.params === undefined ? admission.params : params.value,
          query: query.value,
          body: body.value,
          ...(admission.principal === undefined ? {} : { principal: admission.principal }),
        };
        // The heterogeneous table erases input to never; this endpoint's policies and
        // request schemas above establish the exact input before invoking its binding.
        const reply = await endpoint.handle(input as never);
        return renderReply(endpoint.shape, reply);
      },
      { parse: 'none' },
    );
  }
  return app;
}

/**
 * Fetch forbids reading a GET or HEAD body. Bun retains the HTTP framing but
 * presents nonempty and zero-chunk transfer streams identically: null body,
 * empty text and a Transfer-Encoding header. Unknown is not accepted, so every
 * such stream is refused; Content-Length zero remains provably empty.
 * Proof: bypassing this predicate produced six 200s instead of six 400s in the
 * production /health TCP test across both methods and all three framing cases.
 */
function hasUnreadableBodyFraming(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const octets = Number(contentLength);
    if (!Number.isSafeInteger(octets) || octets < 0 || octets > 0) return true;
  }
  return request.headers.has('transfer-encoding');
}

/**
 * Maps Elysia's body dispatch onto the canonical media families a shape declares.
 * The framework's route parser reads character12 for application media: `j`
 * parses JSON, `x` parses URL encoding and `r` parses multipart. This preserves
 * its existing JSON Patch and XML-form admission without advertising either
 * accidental spelling as a separate OpenAPI representation.
 */
function parserMedia(contentType: string): BodyMedia | undefined {
  switch (contentType.charCodeAt(12)) {
    case 106:
      return 'application/json';
    case 120:
      return 'application/x-www-form-urlencoded';
    case 114:
      return 'multipart/form-data';
    default:
      return undefined;
  }
}

/**
 * Elysia gives a static segment precedence over a parameter at the first divergence.
 * Proof: omitting this ordering applies the protected parameter route's policy
 * to its public static sibling, and the sibling test receives 401 instead of 200.
 */
function comparePaths(left: string, right: string): number {
  const rightSegments = right.split('/');
  for (const [index, segment] of left.split('/').entries()) {
    const difference =
      Number(segment.startsWith(':')) - Number(rightSegments[index]?.startsWith(':'));
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Proof: bypassing validation admits the nested-extra-field request (200 instead
 * of 400); removing await makes the async-validator control receive 500 instead of 200.
 */
async function validateRequest(
  shape: SchemaShape<unknown> | undefined,
  value: unknown,
): Promise<
  { ok: true; value: unknown } | { ok: false; issues: NonNullable<RequestFailure['issues']> }
> {
  if (shape === undefined) return { ok: true, value: undefined };
  const checked = await validateSchema(shape, value);
  return checked.issues === undefined
    ? { ok: true, value: checked.value }
    : { ok: false, issues: checked.issues };
}

/**
 * The endpoint owns the validation refusal's status; codes have no global status mapping.
 * Proof: hardcoding 400 makes the constrained-param test receive 500 instead of
 * 422 because that status is undeclared. Defaulting an undeclared refusal to 400
 * makes the missing-declaration test receive 400 instead of 500.
 */
async function refuse(shape: EndpointShape, body: Refusal): Promise<Response> {
  for (const refusal of shape.refusals) {
    if ('kind' in refusal) continue;
    const checked = await validateSchema(refusal.schema, body);
    if (checked.issues === undefined)
      return renderReply(shape, { ok: false, status: refusal.status, body });
  }
  throw new Error(`Endpoint ${shape.operationId} has no declared validation refusal`);
}

/**
 * Serializes only a representation/status/schema alternative declared by this endpoint.
 * Proof: limiting responses to the first arm makes the later-JSON alternative
 * receive 500 instead of 200; limiting refusals to the first arm makes its later
 * refusal receive 500 instead of 400. Skipping text alternatives makes the same
 * alternative matrix receive 500 instead of 200 for the text arm.
 * Proof: skipping refusal validation gives the status/body test 429 instead of
 * 500; skipping success validation gives it 200 instead of 500. Removing await
 * admits an invalid async success (200) and invalid refusal (429) instead of 500.
 * Ignoring the success status admits undeclared 201 instead of 500.
 * Replacing append with set loses the first two callback cookies; serializing
 * JSON null as an empty response gives the null-body test "" instead of "null".
 */
async function renderReply(shape: EndpointShape, reply: EndpointReply): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of reply.headers ?? []) headers.append(name, value);
  if (!reply.ok) {
    for (const refusal of shape.refusals) {
      if (refusal.status !== reply.status) continue;
      if ('kind' in refusal) {
        if (reply.body === EMPTY) return new Response(null, { status: reply.status, headers });
        continue;
      }
      if ((await validateSchema(refusal.schema, reply.body)).issues === undefined) {
        return Response.json(reply.body, { status: reply.status, headers });
      }
    }
    throw new Error(`Endpoint ${shape.operationId} returned an undeclared refusal`);
  }
  if (
    'body' in reply &&
    reply.body !== null &&
    typeof reply.body === 'object' &&
    'error' in reply.body
  ) {
    throw new Error('Successful response contains a refusal envelope');
  }
  for (const response of shape.responses) {
    if (response.status !== reply.status) continue;
    if (response.kind === 'text') {
      if (!('text' in reply)) continue;
      headers.set('content-type', response.contentType);
      return new Response(reply.text, { status: reply.status, headers });
    }
    if (!('body' in reply)) continue;
    if (response.kind === 'empty') {
      if (reply.body !== EMPTY) continue;
      return new Response(null, { status: reply.status, headers });
    }
    if ((await validateSchema(response.schema, reply.body)).issues === undefined) {
      return Response.json(reply.body, { status: reply.status, headers });
    }
  }
  throw new Error(`Endpoint ${shape.operationId} returned an undeclared success representation`);
}

/**
 * A classifier names a refusal; it never authorizes rejected input.
 * Proof: skipping it changes the earlier-command-semantic test from 400 to 500.
 */
async function classifyFailure(
  endpoint: BoundEndpoint,
  failure: RequestFailure,
): Promise<Response> {
  if (endpoint.classifyRequestFailure === undefined)
    return refuse(endpoint.shape, { error: failure.code });
  return renderRequestRefusal(endpoint.shape, await endpoint.classifyRequestFailure(failure));
}

/**
 * Checks the erased callback's refusal-only contract before normal reply validation.
 * Proof: omitting the success check admits a broken hook with 200 instead of 500;
 * bypassing declared reply validation admits its wrong status/body with 429 instead of 500.
 */
async function renderRequestRefusal(shape: EndpointShape, reply: EndpointReply): Promise<Response> {
  if (reply.ok) throw new Error('Request boundary returned a successful reply');
  return renderReply(shape, reply);
}
