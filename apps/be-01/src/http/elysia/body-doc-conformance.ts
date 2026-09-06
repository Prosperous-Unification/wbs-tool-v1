import type { DocumentDecoration } from 'elysia';

import type { RequestBodyDoc } from '../body-doc';

/**
 * True when `A` is assignable to `B`, and `false` — not an error — when it is
 * not, so the failure lands on the assertion below with both types named in the
 * message rather than inside a helper.
 */
type Assignable<A, B> = [A] extends [B] ? true : false;

/**
 * The one thing `http/body-doc.ts` cannot check about itself: that the shape it
 * declares is still the shape the publisher accepts.
 *
 * `handParsedBody`, `checkedBody` and `tableRefusedBody` build the `requestBody`
 * object that six route modules hand to `Route.documentation.detail`, which this
 * binder passes to `@elysiajs/openapi`. Those helpers live in a framework-free
 * file because
 * importing `DocumentDecoration` from a module the controllers import — even
 * `import type` — is what left `git grep -l elysia apps/be-01/src/controller`
 * matching seven files and acceptance criterion #1 unmet.
 *
 * Declaring the shape by hand there is only safe if something still compares it
 * to the framework's own type, and that comparison belongs on this side of the
 * seam. If an Elysia upgrade narrows `DocumentDecoration['requestBody']`,
 * `requestBodyDocIsElysiaShaped` stops being `true` and `be-01:typecheck`
 * fails here — one file, naming the upgrade as the cause — instead of the
 * document silently losing a body description.
 *
 * This is a type-level assertion with no run-time job. It is exported so the
 * value is not dead code to the linter, and imported by nothing.
 */
export const requestBodyDocIsElysiaShaped: Assignable<
  RequestBodyDoc,
  NonNullable<DocumentDecoration['requestBody']>
> = true;
