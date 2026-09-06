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
