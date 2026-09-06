import { writeFileSync } from 'node:fs';

import { computeFastGoldenCorpus } from './fast-golden-corpus';

/**
 * Rewrites `libs/domain/fixtures/fast-golden-corpus.json` from this tree.
 *
 * **Why this exists.** `fast-golden-corpus.test.ts` asserts the corpus in both
 * directions — the stored bytes must reproduce, *and* the stored
 * `contractVersion` must equal `SCHEDULER_CONTRACT_VERSION` — so a deliberate
 * change to Fast's output is only ever green after the constant is bumped **and**
 * the fixture is regenerated. Until now nothing in the tree performed the second
 * half, and the file's own header called it "regenerated" as if a tool did it.
 * Hand-editing 500+ lines of serialized schedule to match an engine is not a
 * regeneration; it is a transcription, and a transcription that happens to
 * satisfy the comparison is the corpus agreeing with itself.
 *
 * **It writes the same bytes the case reads, from the same function.** The
 * corpus test compares `computeFastGoldenCorpus().cases` against the parsed
 * file; this writes `computeFastGoldenCorpus()` whole. A second serializer here
 * — even one that looked equivalent — would be a second answer to the question
 * the fixture exists to settle, and the two would drift at exactly the moment
 * somebody changed the schedule shape.
 *
 * **Run it only when the change to Fast was intended.** There is no guard in
 * here and there should not be one: the guard is the version bump the test
 * demands next to it, and a script that refused to write would just be a second
 * place to argue with. Running this to make a red suite green is how a golden
 * corpus stops being evidence — the sequence is decide, bump, regenerate, then
 * read the diff.
 *
 *   bun libs/domain/src/write-fast-golden-corpus.ts
 *   bunx prettier --write libs/domain/fixtures/fast-golden-corpus.json
 *
 * **Both lines, and the second is not optional.** `JSON.stringify(…, 2)` breaks
 * a single-element array across three lines where `prettier` keeps it on one,
 * so the generated file and the checked-in file differ in exactly two places —
 * the `capacityPredecessorIds` of the two capacity-bound slices — and the
 * format check, not the corpus, is what would go red.
 *
 * **Proved against the fixture already in the tree**, which is the only control
 * that means anything here: on h2puni at `5955aaf3`, with Fast unchanged, this
 * script followed by that `prettier --write` reproduced
 * `fast-golden-corpus.json` **byte for byte** — md5 `05d6b67b`, `git diff`
 * empty. So a diff after a real change is the engine moving and nothing else.
 * A writer that had never been run against the current fixture would leave
 * every future regeneration carrying an unknown amount of its own formatting.
 */
const target = new URL('../fixtures/fast-golden-corpus.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(computeFastGoldenCorpus(), null, 2)}\n`);
process.stdout.write(`wrote ${target.pathname}\n`);
