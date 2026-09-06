import {
  type ClientFailure,
  clientFromShapes,
  type EndpointShape,
  fetchTransport,
} from '@wbs/contracts';

/**
 * Shape-derived browser calls use the serving origin and its cookies. Fetch is
 * resolved per invocation, and no request sharing or invalidation lives here.
 */
export function browserClient<const Shapes extends readonly EndpointShape[]>(shapes: Shapes) {
  return clientFromShapes(shapes, (shape, input) =>
    fetchTransport(location.origin, (url, init) => {
      const address = new URL(url);
      return fetch(`${address.pathname}${address.search}`, init);
    })(shape, input),
  );
}

/** Unknown discriminants indicate a programming error rather than a modeled refusal. */
export function unreachable(value: never): never {
  throw new Error(`Unexpected response variant: ${typeof value}`);
}

/** Boundary failures remain distinct from validated application refusal messages. */
export function failureMessage(failure: ClientFailure): string {
  switch (failure.code) {
    case 'cancelled':
      return '';
    case 'transport':
      return 'Could not reach the server. Try again.';
    case 'invalid_request':
      return 'The request could not be sent. Reload and try again.';
    case 'invalid_response':
    case 'unexpected_status':
      // Proof: removing this distinction showed the generic response error instead
      // of the site-gateway message in the actual AuthForm edge-challenge test.
      if (failure.status === 401 && failure.headers.has('www-authenticate'))
        return 'The site gateway rejected the request. Check your site access and try again.';
      return 'The server returned an unexpected response. Try again.';
    default:
      return unreachable(failure);
  }
}
