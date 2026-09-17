import { type } from 'arktype';

import { responseSchema } from './schema-shape';

/** A live schedule read cannot use the engine selected by the stored project. */
export const engineUnavailableRefusal = {
  status: 409,
  schema: responseSchema(type({ error: "'engine_unavailable'", engine: "'optimized'" })),
} as const;
