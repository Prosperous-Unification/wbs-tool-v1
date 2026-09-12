import { computeQuantumGoldenCorpus } from '@wbs/domain';

import { writeGoldenCorpusFile } from './write-golden-corpus-file';

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
 *   bun tools/dev/write-solver-quantum-golden-corpus.ts
 *
 * **One line.** This used to require a `bunx prettier --write` after it, because
 * `JSON.stringify(…, 2)` and prettier do not agree about every shape and the
 * format check — not the corpus — went red on the difference. TASK-356 moved
 * that rule into {@link writeGoldenCorpusFile}. This fixture never actually
 * failed the check, but only because its content happened to contain no short
 * array whose shape moved; the writer had the same defect as Fast's and is fixed
 * with it rather than left to fail later.
 */
const target = new URL(
  '../../libs/domain/fixtures/solver-quantum-golden-corpus.json',
  import.meta.url,
);
process.stdout.write(
  `wrote ${await writeGoldenCorpusFile(target, computeQuantumGoldenCorpus())}\n`,
);
