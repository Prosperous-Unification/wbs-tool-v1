# Task 2.1 report — project source family

## Scope completed

- Added the three manifest project cases to the shared registration order and
  independent implemented-case inventory.
- Ran complete project creation fields and ordered starting steps, scoped
  update plus unknown refusal, and caller-specific access ordering through both
  `openMemorySource` and `openSqliteSource`.
- Kept the two seeded owners/projects distinct and supplied literal write stamps
  for every targeted operation.
- Added source-specific typed decorators for omitted starting steps, a broadened
  project update and an ignored access user. Each uses the actual store method
  after verified inert setup.

## TDD and R5 evidence

The independent registration test first failed with all three `projects.*`
IDs absent. Both actual source fault runs then produced the same observed
failures: the created project's expected two steps became `[]`; project B's
name became `Renamed project`; and owner B's expected `Project 1, Project 2`
order became `Project 2, Project 1`. Adjacent `Proof:` comments quote those
outputs. Each source then reran the three unchanged registrations successfully.

No new gap was needed. Memory passed all project cases; its existing exact
`estimates.set:unknown_step` declaration remains truthful and unchanged.

## Verification

- Focused inventory: 1 pass.
- Focused memory source: 3 pass, 72 assertions.
- Focused SQLite source: 9 pass, 398 assertions.
- Existing SQLite project repository/settings suites: 35 pass, 87 assertions.
- Conformance target: 29 pass, 47 assertions.
- Memory target: 24 pass, 270 assertions.
- SQLite target: 654 pass, 2,407 assertions across 60 files.
- All six relevant lint/typecheck targets passed, including the missing-family
  compile fixture.
- OpenSpec strict and all 75 artifacts passed.

## Scope boundary and skips

No account/configuration or later store family was implemented. The full
workspace, build, browser and deploy gates were skipped because this slice adds
only project conformance cases and test-only fault decorators; it changes no
transport, UI, migration or deployment behavior.
