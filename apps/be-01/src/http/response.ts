import type { RouteResponse } from './route';

/**
 * One {@link RouteResponse} onto the wire, shared by every binder.
 *
 * The in-process binder always builds a `Response`; the Elysia binder builds
 * one only for a response carrying {@link RouteResponse.cookies}, because
 * Elysia's `set.headers` holds a single value per name and cannot express a
 * repeated `Set-Cookie`. Both call this, so the two binders cannot disagree
 * about what a route's answer *is* — which is the property
 * `binder.contract.test.ts` exists to hold, and it would be lost the moment
 * each binder wrote its own serialiser.
 *
 * `Response` is a web platform type, not a framework one: this file names no
 * HTTP framework, which is why it sits beside `route.ts` rather than under
 * either binder.
 */
export function toResponse(res: RouteResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers ?? {})) headers.set(name, value);
  // `append`, not `set`: the whole reason `cookies` is its own field is that
  // these lines repeat. RFC 6265 §3 has no comma-joined form, so a client
  // handed the folded spelling reads one malformed cookie rather than three.
  for (const value of res.cookies ?? []) headers.append('set-cookie', value);

  if (res.serialised === true) {
    return new Response(String(res.body), { status: res.status, headers });
  }
  // 204 carries no body at all; `JSON.stringify(null)` would put the four bytes
  // `null` on the wire and make a no-content answer indistinguishable from a
  // route that answered with the JSON value null.
  if (res.status === 204 || res.body === null) {
    return new Response(null, { status: res.status, headers });
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}
