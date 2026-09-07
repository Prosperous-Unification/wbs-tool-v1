import { writeFileSync } from 'node:fs';

import { computeQuantumGoldenCorpus } from './solver-quantum-golden-corpus';

/**
 * Rewrites `libs/domain/fixtures/solver-quantum-golden-corpus.json` from this
 * tree.
 *
 * **Why this exists**, and it is `write-fast-golden-corpus.ts`'s reason for the
 * sibling corpus: the test asserts in both directions — the stored bytes must
 * reproduce, *and* the stored `contractVersion` must equal
 * `SCHEDULER_CONTRACT_VERSION` — so a deliberate change to `quantise` is only
 * ever green after the constant is bumped **and** the fixture is regenerated.
 * A fixture with no writer is one somebody hand-edits until the comparison
 * stops complaining, which is the corpus agreeing with itself.
 *
 * **It writes the same bytes the test reads, from the same function.** The test
 * compares `computeQuantumGoldenCorpus().cases` against the parsed file; this
 * writes `computeQuantumGoldenCorpus()` whole. A second serializer here would
 * be a second answer to the question the fixture exists to settle.
 *
 * **Run it only when the change to `quantise` was intended.** There is no guard
 * in here and there should not be one: the guard is the version bump the test
 * demands next to it. Running this to make a red suite green is how a golden
 * corpus stops being evidence — the sequence is decide, bump, regenerate, then
 * read the diff.
 *
 *   bun libs/domain/src/write-solver-quantum-golden-corpus.ts
 *   bunx prettier --write libs/domain/fixtures/solver-quantum-golden-corpus.json
 *
 * **Both lines.** `JSON.stringify(…, 2)` and `prettier` do not agree about
 * every shape, and the format check — not the corpus — is what would go red on
 * the difference. The Fast writer's header records that trap concretely.
 */
const target = new URL('../fixtures/solver-quantum-golden-corpus.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(computeQuantumGoldenCorpus(), null, 2)}\n`);
process.stdout.write(`wrote ${target.pathname}\n`);
