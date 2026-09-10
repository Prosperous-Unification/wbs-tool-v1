# Verification

## Slice 1.1 — baseline and contracts

Baseline `7851161bf96312750d07b933ca5d42b75ce575c7` / tree
`b661e693e9c6656986fd431f4654df6db8dc3afc` contains 2,805 tracked entries. A Bun comparison
of every stored path/mode/blob tuple against `git ls-tree -r -z` reported
`exact tuple match: 2805 entries; referenced schema hashes match`.

The initial focused RED was `bun test src/contracts/contracts.test.ts` in
`tools/tool-wiki`: 0 pass, 9 fail after the wished-for API existed as an explicit
not-implemented boundary. The first full GREEN was 9 pass, 0 fail, 66 assertions; the
final suite extends that production-boundary matrix.

Every decoder fault below was injected separately, run through the real
`bun run src/cli.ts validate ...` subprocess used by the test, observed accepting the malformed
record, and restored. Each failed with `Expected: 1, Received: 0` after printing the shown line.

| Fault                                            | Observed malformed acceptance                         |
| ------------------------------------------------ | ----------------------------------------------------- |
| committed selection tree made optional           | `valid candidate-inventory`                           |
| schema version widened                           | `valid candidate-entry`                               |
| relative membership grammar widened              | `valid granularity-policy`                            |
| integration mapping made optional                | `valid granularity-policy`                            |
| duplicate mapping-group guard removed            | `valid granularity-policy`                            |
| duplicate module guard removed                   | `valid module-mapping`                                |
| duplicate corpus/manifest outcome guards removed | `valid benchmark-corpus`; `valid experiment-manifest` |
| acceptance nonempty guard removed                | `valid benchmark-corpus`                              |
| three-seed minimum removed                       | `valid experiment-manifest`                           |
| raw usage or price identity made optional        | `valid invocation-receipt`                            |
| elapsed receipt duration made optional           | `valid elapsed-receipt`                               |
| receipt undeclared-key rejection removed         | `valid invocation-receipt` with `receiptBlob`         |
| exact-entry unique/sorted guards removed         | `valid candidate-inventory`                           |

`NX_DAEMON=false bunx nx typecheck tool-wiki --skip-nx-cache` rejected a deliberate source
error at `records.ts(4,7)` and a separate deliberate test error at
`contracts.test.ts(7,7)`, both TS2322 (`string` not assignable to `number`).
`NX_DAEMON=false bunx nx lint tool-wiki --skip-nx-cache` rejected an unused source binding;
direct ESLint output named `@typescript-eslint/no-unused-vars`. All faults were restored.

Nx could not create its sandbox socket and explicitly ran plugins in-process. This warning did
not skip targets. No full repository or browser gate was run for this isolated contract slice.

## Slice 1.1 fix round 1

The fixed corpus replaces `outcome.event-log-conformance`, whose event-log behavior already
existed at the baseline, with `outcome.source-certification-execution` from approved
`source-conformance-completion` task 7.2. Its acceptance runs the SQLite and memory source
certification targets separately. A Bun check parsed each source's `project.json` directly from
baseline `7851161b`; both lacked `test:conformance`, proving the outcome unmet at that revision.

New production CLI tests were RED before implementation: all four noncanonical path records,
all four invalid-instant/interval records, all four empty/blank outcome records, and a completed
invocation with `rawUsage: []` printed `valid ...` and returned exit 0. The fixed-corpus test was
also RED because the replacement outcome was absent. Individual restored fault injections then
observed these precise failures:

| Removed check                       | Production oracle observation                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| canonical path narrow               | `[0, 0, 0, 0]`; three `valid candidate-entry`, one `valid granularity-policy` |
| real-instant narrow                 | invalid February instant returned 0 at position 1                             |
| invocation interval order           | reversed invocation returned 0 at position 2                                  |
| elapsed exact wall-clock difference | `elapsedMs: 59999` returned 0 at position 3                                   |
| check exact wall-clock difference   | `elapsedMs: 60001` returned 0 at position 4                                   |
| whitespace acceptance refusal       | corpus and manifest blank criteria returned 0 at positions 3/4                |
| benchmark nonempty outcome guard    | empty benchmark corpus returned 0 at position 1                               |
| manifest nonempty outcome guard     | empty manifest corpus returned 0 at position 2                                |
| completed raw-usage guard           | `valid invocation-receipt`; expected 1, received 0                            |

Receipt elapsed time now means exactly `Date.parse(endedAt) - Date.parse(startedAt)` in UTC
milliseconds, with real canonical UTC instants required. Invocation intervals require nondecreasing
end time. Completed invocation receipts require at least one raw usage entry; failed/censored
statuses remain distinct, and aggregation remains task 7.1.

## Slice 1.2 — candidate inventory reader

`read-candidate` now requires an explicit committed, staged or working selection and a repository
path. Committed mode resolves an immutable commit/tree before `git ls-tree -r -z`. Staged mode
freezes the index with `git write-tree`, inventories that tree and refuses if a second tree differs.
Working mode is explicitly diagnostic: two temporary-index snapshots freeze tracked working bytes,
untracked paths remain a separate sorted set, and either index or working-tree movement refuses the
selection. Exact path/mode/blob tuples retain executable modes and symlink blobs without following
links.

Initial RED on
`NX_DAEMON=false bunx nx test tool-wiki --skip-nx-cache --output-style=static` was exit 1: the
existing 16 tests passed, the seven new CLI cases failed against the old `validate`-only usage, and
`inventory/read-candidate.test.ts` could not load the absent module. First GREEN was 23 pass, zero
fail, 202 assertions. After extending both race modes and malformed Git-output coverage, the final
focused Nx run is recorded in the task report.

All mutations below ran through `src/cli.test.ts`, which spawns the production CLI against temporary
real Git repositories. Each fault was restored before the next.

| Deliberate fault                                         | Observed production-oracle failure                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| omit the staged addition                                 | complete tuple/selection mismatch; `added.txt` absent                     |
| drop another selected path                               | complete tuple/selection mismatch; `link` absent                          |
| substitute `deleted.txt` for `link` at equal count       | one-path complete tuple mismatch                                          |
| inventory the base tree instead of the staged index tree | addition/deletion, both rename sides and executable mode all mismatched   |
| remove staged index recheck                              | race CLI exited 0; expected 1                                             |
| remove working index recheck                             | working race CLI exited 0 with stale tracked snapshot; expected 1         |
| remove double working-tree snapshot comparison           | tracked-byte race CLI exited 0; expected 1                                |
| remove required-index preflight                          | absent index became Git's empty tree with `entries: []`; expected refusal |
| classify EACCES as malformed                             | exact unreadable diagnostic was absent                                    |
| substitute Git's empty tree on malformed index           | CLI exited 0 with `entries: []`; expected 1                               |
| replace ls-tree failure/parsing with `return []`         | failed ls-tree CLI exited 0 with `entries: []`; expected 1                |

The malformed-output fixture also broke the Git dependency with an exit 17, missing NUL terminator,
missing path separator, invalid header and mode/type conflict; every case exited 1 at its named
boundary. No tuple-count minimum or zero-entry error fallback is used: a legitimately empty selected
tree is distinct from failed required state.

Final focused verification was
`NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static`:
exit 0, lint plus source/spec typecheck passed, and 25 tests passed with zero failures and 238
assertions. `openspec validate agent-scalable-llm-wiki --strict` was unavailable (`openspec: command
not found`) and is not represented as passing.

## Slice 1.2 fix round 1

The reader now binds index selection to captured bytes and recaptures the required live index after
the read, preserves leading BOM path code points, normalizes interior repository arguments to the
worktree root, rejects empty untracked records, hashes working manifests with recursively
key-sorted canonical JSON, and checks untracked membership independently of tracked bytes.

Production CLI REDs observed before each fix were: missing index after preflight selected Git's
empty tree and exited 0; BOM/plain paths collapsed; an interior working request omitted root state;
a single NUL became `untracked: [""]`; insertion-order JSON emitted tracked hash `4db8d6...` instead
of canonical `da04baf...`; and removing only the untracked comparison omitted a path created between
passes while exiting 0. Each restored case passed. Exact full fault output is retained in the task
report, and adjacent source `Proof:` comments name the observed production oracle.

Final focused verification:

```text
NX_DAEMON=false bunx nx run-many -t lint typecheck test -p tool-wiki --skip-nx-cache --output-style=static
```

Exit 0: lint passed, source and spec typecheck passed, and 30 tests passed with zero failures and 284
assertions. Nx could not create its sandbox socket and explicitly ran plugins in-process; no target
was skipped. `openspec validate agent-scalable-llm-wiki --strict` returned exit 127 because the
OpenSpec executable is unavailable. The full repository/browser gates were not run for this
isolated reader fix.
