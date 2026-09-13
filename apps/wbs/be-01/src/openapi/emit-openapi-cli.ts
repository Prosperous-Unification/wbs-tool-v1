import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { documentFromShapes, httpShapes } from '@wbs/contracts';

/**
 * Generates a document from shared descriptors. With a destination argument it
 * writes that build artifact; without one it writes JSON to stdout. No committed
 * document or app fixture is an input, and importing this module has no effects.
 * Proof: before the production build invoked this entrypoint, a fresh uncached
 * be-01 build produced only main.js and no OpenAPI artifact.
 */
if (import.meta.main) {
  const serialized = `${JSON.stringify(documentFromShapes(httpShapes), null, 2)}\n`;
  const destination = process.argv.at(2);
  if (destination === undefined) process.stdout.write(serialized);
  else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, serialized, 'utf8');
  }
}
