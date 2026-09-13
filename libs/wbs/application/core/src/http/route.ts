/** True for a JSON object whose named fields can be read safely. */
export function isFieldBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
