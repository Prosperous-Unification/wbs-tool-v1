# Verification

2026-09-06, refactoring worktree.

- Initial focused negative: 1 pass, 2 fail (secondary-team revision/audit and stale undo).
- `bun test apps/be-01/src/repository/directory.db.test.ts apps/be-01/src/service/undo.db.test.ts apps/be-01/src/service/directory.service.db.test.ts`: 149 pass, 0 fail, 440 assertions.
- Restored legacy-only revision stamping after the fix: focused run 1 pass, 2 fail; fix restored afterward.
- Focused regressions after restoring the fix: 3 pass, 0 fail, 23 assertions.
- Targeted ESLint on directory.ts, directory.db.test.ts and undo.db.test.ts: exit 0.
- `openspec validate team-removal-revisions --strict`: valid, exit 0.
- Workspace gates and full backend suite are pending the coordinating parent's frozen-tree run. No browser or deployment checks apply to this repository fix.

| Injected fault                                    | Production-path test                                    | Observed failure                                   |
| ------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Restore legacy singleton revision/stamp filtering | stamps each affected row once when removing team zzz    | revision 1 instead of 2; updatedAt 1 instead of 42 |
| Same fault                                        | refuses a rename undo after removal of a secondary team | expected a refusal, got: rename “Renamed”          |

The existing audit schema stores updatedAt and preserves createdBy; it has no updatedBy column. No schema expansion was made.

Parent verification: `bunx nx typecheck be-01 --skip-nx-cache` passed on the frozen backend sources containing R2 and R3. Independent task review approved with no findings. Full workspace gate remains pending.

## Archive reconciliation, 2026-09-08

Current `main` at `5516d453` retains the join-derived affected set, exactly-once
revision stamp and stale-undo behavior. The exact three touched database suites
passed **151/151 tests with 456 assertions**. Fresh `be-01:typecheck
--skip-nx-cache` and `be-01:lint --skip-nx-cache` passed on this source.

The full workspace gate for PR #356's exact head `cb0f13ee` also passed with the
same A5 implementation present. The later combined-main run `34272524792` was
still in progress when reconciled and already had an unrelated browser-shard
failure; no browser evidence is claimed for this repository-only change.

No `team-removal-revisions` main spec existed before sync. This delta introduces
its two requirements and four scenarios, matching
`docs/refactoring/r1-r9-spec-inventory.md`.
