import { type Type, type } from 'arktype';

import { ValidationError } from './errors';

export { type };
export type { Type };
export { ValidationError };

/**
 * Parse, or throw naming what was wrong with it.
 *
 * The message is ArkType's own summary and **no longer repeats the input**. It
 * used to open with `JSON.stringify(input)`, so every refusal echoed the whole
 * value back into a log line — for an HTTP body that is the caller's own data
 * arriving twice, and for anything holding a credential it is the credential.
 *
 * The summary is safe for a caller's own data and is **not** safe for secrets:
 * measured on arktype 2.x, a type mismatch reads `PORT must be a number (was a
 * string)`, but a literal union or a regex quotes what it got — `MODE must be
 * "dev" or "prod" (was "sekrit")`. Use {@link parseSecretsOrThrow} when the
 * input holds values nobody may print.
 */
export function parseOrThrow<T extends Type>(schema: T, input: unknown): T['infer'] {
  const result = schema(input);
  if (result instanceof type.errors) {
    throw new ValidationError(`Validation failed: ${result.summary}`, result);
  }
  return result;
}

/**
 * Parse something whose values must never reach a log, naming only the keys.
 *
 * For an environment, a token payload, or anything else where the value is the
 * secret. It reports the failing paths and nothing else — not the summary, not
 * the expectation, and no `cause`, because every one of those can carry the
 * value:
 *
 * - `error.actual` is the value, quoted.
 * - `error.expected` is contaminated too. For a literal union arktype puts its
 *   whole message there, value included (`MODE must be "dev" or "prod" (was
 *   "sekrit")`), so there is no field that is reliably safe but the path.
 * - `cause` would hand the same errors object to anything that prints it.
 *
 * So this trades the reason for a guarantee. That is the right trade here: the
 * schema is in the repo next to the caller and says what each key must be, and
 * a boot failure that prints `JWT_SIGNING_KEY_CURRENT` is worse than one that
 * makes somebody open a file.
 */
export function parseSecretsOrThrow<T extends Type>(schema: T, input: unknown): T['infer'] {
  const result = schema(input);
  if (result instanceof type.errors) {
    const named = [...new Set(result.map((each) => each.propString))].filter((each) => each !== '');
    // An empty list means the whole value was refused rather than a key of it —
    // a string where an object was owed. Saying so beats naming nothing.
    const where = named.length === 0 ? 'the value itself' : named.join(', ');
    throw new ValidationError(`Validation failed for ${where}`);
  }
  return result;
}
