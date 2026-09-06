import { ClientConfigurationError } from './client-error';
import type { ClientTransport } from './client-types';
import { bodyMediaFor } from './endpoint-shape';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Builds absolute fetch URLs; callers explicitly supply their deployment's base URL. */
export function fetchTransport(baseUrl: string, send: Fetch = fetch): ClientTransport {
  const base = new URL(baseUrl);
  return (shape, input) => {
    let encoded: { url: string; init: RequestInit };
    try {
      // Proof: removing this guard made the form-only declaration client test resolve instead of rejecting.
      if (shape.body !== undefined && !bodyMediaFor(shape).includes('application/json'))
        throw new ClientConfigurationError(
          'Fetch JSON transport requires application/json body media',
        );
      const path = shape.path
        .split('/')
        .map((segment) => {
          if (!segment.startsWith(':')) return encodeURIComponent(segment);
          const value = input.params[segment.slice(1)];
          if (value === undefined)
            throw new ClientConfigurationError('Validated path parameter is missing');
          // Proof: raw substitution failed the fetch URL case: a/b became path segments and ?# escaped into URL syntax.
          return encodeURIComponent(value);
        })
        .join('/');
      const url = new URL(path, base);
      if (input.query !== undefined) {
        if (typeof input.query !== 'object' || input.query === null || Array.isArray(input.query))
          throw new ClientConfigurationError('Query schema must describe a field object');
        for (const [name, value] of Object.entries(input.query)) {
          if (value === undefined) continue;
          if (typeof value !== 'string')
            throw new ClientConfigurationError('Query schema must describe string values');
          url.searchParams.append(name, value);
        }
      }
      const headers = new Headers(input.headers);
      if (input.body !== undefined) headers.set('content-type', 'application/json');
      encoded = {
        url: url.href,
        init: {
          method: shape.method,
          headers,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal: input.signal,
          redirect: 'manual',
        },
      };
    } catch (cause) {
      if (cause instanceof ClientConfigurationError) throw cause;
      throw new ClientConfigurationError('Cannot encode validated client request', { cause });
    }
    return send(encoded.url, encoded.init);
  };
}
