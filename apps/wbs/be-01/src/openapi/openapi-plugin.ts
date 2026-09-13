import { documentFromShapes, type EndpointShape } from '@wbs/contracts';
import { Elysia } from 'elysia';

/** Public JSON document endpoint; no hosted viewer or external scripts are installed. */
export const OPENAPI_SPEC_PATH = '/api/openapi.json';

/**
 * Publishes only the shared descriptors mounted in this app configuration.
 * Operational routes join this document only when they acquire real shared bindings.
 */
// Proof: changing this route path made the actual-app publication test fail on /api/openapi.json answered 404.
// Proof: publishing the full registry in local-auth mode made the production app
// advertise 44 operations while it mounted 40 (openapi-document.test.ts).
export const openApiPlugin = (shapes: readonly EndpointShape[]) =>
  new Elysia().get(OPENAPI_SPEC_PATH, () => documentFromShapes(shapes));
