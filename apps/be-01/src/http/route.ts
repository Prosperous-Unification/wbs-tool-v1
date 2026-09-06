/**
 * Legacy handler primitives retained only by {@link callerGuard} until task 5.2.
 * Production controllers use shared `EndpointShape` declarations and
 * `BoundEndpoint` handlers through `http/elysia/mount.ts`.
 */
export type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export interface RouteRequest {
  method: HttpMethod;
  receivedMethod: HttpMethod | 'HEAD';
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: unknown;
  url: string;
}

export interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  cookies?: readonly string[];
  serialised?: boolean;
}

export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse>;
export type RoutePreflight = (request: RouteRequest) => Promise<RouteResponse | null>;

/** True for a JSON object whose named fields can be read safely. */
export function isFieldBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A legacy handler refusal retained with {@link callerGuard} until task 5.2. */
export function respond(status: number, body: unknown): RouteResponse {
  return { status, body };
}

/**
 * Matches the literal and `:parameter` paths used by policy lookup.
 * One trailing request slash is ignored because Elysia does the same.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/');
  const actual = (
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  ).split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const given = actual[index] ?? '';
    if (segment.startsWith(':')) {
      if (given === '') return null;
      // Elysia types parameters as strings but supplies null when percent
      // decoding fails. This boundary reproduces that measured behavior.
      params[segment.slice(1)] = decodeSegment(given) as unknown as string;
    } else if (segment !== given) {
      return null;
    }
  }
  return params;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
