# Task 2 report — OpenSpec slice 1.2

## Implementation

Implemented the candidate inventory reader and exposed it through the existing thin CLI as:

```text
tool-wiki read-candidate <committed|staged|working> <repository> <revision-or-base>
```

Committed requests resolve their revision to a full commit and tree identity before reading exact
`git ls-tree -r -z --full-tree` tuples. Staged requests resolve the explicit base, require a readable
index, snapshot it with `git write-tree`, inventory that immutable tree, and compare a second index
tree after the read. Working requests remain visibly diagnostic in their selection tag: a temporary
index seeded from the selected index tree freezes tracked worktree bytes twice, while untracked paths
are read separately. Their SHA-256 manifest identities bind the returned tracked tuples and
untracked path set. Concurrent index, tracked-byte or untracked-set movement refuses the snapshot.

The reader preserves Git's path, mode and blob fields, including executable `100755`, symlink
`120000` blobs, and `160000` Gitlinks. It never follows symlinks. Git's index-tree behavior captures
candidate additions and deletions; the exact tuple oracle also proves both rename sides (old absent,
new present). Git command, UTF-8, NUL framing, entry header, object-kind and required-state failures
are fail-closed under stable `CandidateReadError.failure` categories. There is no error-to-empty
fallback.

Only OpenSpec checkbox 1.2 was marked complete. The already-merged core extraction was not touched,
and the hash-bound slice 1.1 contracts/baseline evidence did not need changing.

## Files

- `tools/tool-wiki/src/inventory/read-candidate.ts`
- `tools/tool-wiki/src/inventory/index.ts`
- `tools/tool-wiki/src/inventory/read-candidate.test.ts`
- `tools/tool-wiki/src/cli.ts`
- `tools/tool-wiki/src/cli.test.ts`
- `openspec/changes/agent-scalable-llm-wiki/tasks.md`
- `openspec/changes/agent-scalable-llm-wiki/verify.md`
- `.superpowers/sdd/tasks/task-2-report.md`

## RED/GREEN

Baseline command:

```text
NX_DAEMON=false bunx nx test tool-wiki --skip-nx-cache --output-style=static
```

Before the new tests, exit 0: 16 pass, zero fail, 108 assertions. After writing the tests and before
implementation, the same command exited 1: the existing 16 passed; seven CLI tests failed because
the production command still printed `usage: tool-wiki validate <record-kind> <json-path>`; the
reader test had one module-load error because `./read-candidate` did not exist. One staged fixture
also exposed an invalid Bun stdin setup; it was corrected without weakening the production RED.

The first implementation GREEN on that exact command was exit 0: 23 pass, zero fail, 202 assertions.
The suite was then extended to execute the index guard in both staged and working modes, the tracked
working-byte guard, and malformed/failed `ls-tree` records. Final command evidence is below.

## Deliberate fault proofs

Every mutation used this production path (with the relevant test-name filter):

```text
bun test --preload ../test/scratch/preload.ts src/cli.test.ts -t '<case>'
```

- `readTree(...).slice(1)` omitted candidate addition `added.txt`: the exact candidate oracle failed
  with `complete tuple/selection mismatch`, 0 pass / 1 fail.
- Filtering out `link` dropped a distinct selected path: the same oracle named the missing `120000`
  tuple, 0 pass / 1 fail.
- Mapping `link` to `deleted.txt` kept four entries: the oracle showed exactly one expected/received
  path difference, 0 pass / 1 fail.
- Reading the resolved base tree in staged mode produced `deleted.txt`/`renamed-from.txt`, omitted
  `added.txt`/`link`, and returned `script.sh` as `100644`; the index-tree oracle failed all those
  actual-candidate differences, 0 pass / 1 fail.
- Removing the staged index-tree comparison let the injected index mutation return a stale snapshot
  and exit 0; the test failed on `Expected: 1, Received: 0`.
- Removing the working index-tree comparison likewise made the working half return a stale tracked
  snapshot and exit 0; `Expected: 1, Received: 0`.
- Removing the double working-tree comparison let a tracked file change between temporary-index
  passes and exit 0; `Expected: 1, Received: 0`.
- Removing the readable-index preflight let an absent index become tree
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, `entries: []`, exit 0; expected 1.
- Changing the EACCES branch to `malformed-index` failed the unreadable-state oracle on
  `Expected to contain: "unreadable required Git index"`.
- Returning the empty tree after failed `write-tree` let malformed index bytes produce
  `entries: []`, exit 0; expected 1.
- Replacing the `ls-tree` failure/parser boundary with `return []` let injected exit 17 return a
  committed selection with `entries: []`, exit 0; expected 1.

Adjacent `Proof:` comments were written only after these outputs were observed. The final malformed
Git dependency matrix injected exit 17, unterminated NUL framing, no path separator, an invalid mode
header and a blob-mode/commit-kind conflict; each production CLI call exited 1 with its distinct
message.

## Verification

- `NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static`:
  exit 0 before documentation finalization; source and spec TypeScript projects compiled, ESLint
  passed, and 24 tests passed with zero failures and 221 assertions. A final fresh run after all task
  edits is recorded below before commit.
- The same final command after every source/test/document edit: exit 0; lint and both source/spec
  typecheck projects passed; 25 tests passed, zero failed, with 238 assertions.
- `bunx prettier --write` formatted the five changed TypeScript files.
- `git diff --check`: exit 0 before documentation finalization; rerun below before commit.

## Self-review

- The staged candidate is read from its captured index tree, never from HEAD; the selected base is
  metadata for later addition/deletion comparison, not an alternate inventory source.
- Working snapshots use a separate temporary index and do not modify the user's index. The temporary
  index is always removed in `finally`; Git object creation is intentional because it makes tracked
  bytes immutable for the diagnostic read.
- Untracked paths never enter the tracked tuple set. Their set identity is separate and checked on
  both passes; the design freezes tracked bytes but reports untracked content separately.
- Missing repository/revision/index, unreadable index, malformed index/Git output, concurrent index
  movement and concurrent working movement are not defaults; each has a distinct error category.
- No `any`, unchecked assertion, eslint disable, catch-and-continue, or vague forbidden identifier
  was introduced. Existing contract/hash-bound evidence files were unchanged.

## Concerns and skipped checks

- Full repository and browser gates are disproportionate to this isolated infrastructure reader and
  were not run. The parent coordinator can include this commit in the eventual host gate.
- `openspec validate agent-scalable-llm-wiki --strict` was unavailable: `/bin/bash: openspec: command
  not found`. It is explicitly skipped, not represented as passing.
- Working mode intentionally binds untracked path membership, not untracked bytes; the normative
  design says tracked bytes are frozen while untracked paths are reported separately, and working
  evidence is diagnostic rather than admissible.
