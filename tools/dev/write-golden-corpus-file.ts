import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

/**
 * Serialises a golden corpus to its fixture **in the bytes the format gate
 * accepts**, so that running a documented regeneration command on a clean tree
 * leaves `bunx nx format:check --all` green.
 *
 * **The defect this closes (TASK-356).** Both writers used
 * `JSON.stringify(…, 2)` and their headers then told the reader to run
 * `bunx prettier --write` on the result. The two disagree: `JSON.stringify`
 * breaks a single-element array over three lines where prettier keeps it on one.
 * Measured 2026-09-07 on `test/corpus-version-lint-watched-red`, regenerating
 * `fast-golden-corpus.json` from a real semantic change produced two hunks of
 * exactly that shape, on the `capacityPredecessorIds` of the two capacity-bound
 * slices. So anyone who ran the first line and not the second got a red run —
 * and `Format` is `ci.yml`'s FIRST gate step, so **every later step, including
 * the `Corpus version lint` the regeneration existed to satisfy, is skipped.**
 * It cost a full dispatch cycle on TASK-338's own control (run 34149530310), and
 * the failure names a fixture rather than the writer, so the message does not
 * point at the cause.
 *
 * **Prettier as a library, not a shell-out and not hand-rolled rules — the
 * decision AC #1 asks for, and why.** `resolveConfig` reads the same
 * `.prettierrc.json` that `nx format:check` resolves for this path, so the
 * writer cannot drift from the gate it has to satisfy: there is one formatter
 * and one config, and changing the config changes both at once. A shell-out
 * would put a process spawn and a PATH assumption into a script that is
 * otherwise pure Bun, and would still be the same formatter reached the long way
 * round. Hand-rolled formatting is the option AC #1 rules out in its own words —
 * a second formatter to keep in step — and it is how the disagreement being
 * fixed here got in.
 *
 * `filepath` is what tells prettier this is JSON; it infers the parser from the
 * path rather than being told a parser name, which keeps the inference identical
 * to the gate's.
 *
 * Returns the path written, so a caller's log line names a real file.
 */
export async function writeGoldenCorpusFile(target: URL, corpus: unknown): Promise<string> {
  const path = fileURLToPath(target);
  const config = await resolveConfig(path);
  const formatted = await format(`${JSON.stringify(corpus, null, 2)}\n`, {
    ...config,
    filepath: path,
  });
  writeFileSync(target, formatted);
  return path;
}
