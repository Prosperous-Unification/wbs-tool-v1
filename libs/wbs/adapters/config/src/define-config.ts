import { parseSecretsOrThrow, type Type } from '@wbs/validation';

/**
 * One process's environment, checked against the schema it declares.
 *
 * **Through {@link parseSecretsOrThrow}, and that is the whole point of this
 * function.** The env source handed in is the entire environment — every
 * signing key, every shared secret, the basic-auth password — so a refusal must
 * name the variable and never its value. It used to go through `parseOrThrow`,
 * which opened its message with `JSON.stringify(input)`: one mistyped
 * `LOG_LEVEL` printed every secret be-01 or gw-01 holds into the boot log.
 *
 * `apps/mcp-01/src/config.ts` refused to use this function over exactly that,
 * and says so in its own doc. Its reason is fixed here rather than in a second
 * reader.
 */
export function defineConfig<T extends Type>(
  schema: T,
  envSource: Record<string, string | undefined> = process.env,
): T['infer'] {
  return parseSecretsOrThrow(schema, envSource);
}
