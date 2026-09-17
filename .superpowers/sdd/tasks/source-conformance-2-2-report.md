# Task 2.2 report — user source family

## Scope completed

- Added the four manifest user cases to shared registration and the independent
  implemented-case inventory.
- Exercised complete local account writes/reads, duplicate username refusal,
  issuer-plus-subject OIDC resolution, and verified-email conflict refusal
  through both `openMemorySource` and `openSqliteSource`.
- Kept authentication transport and later configuration families outside this
  slice.

## TDD and R5 evidence

The independent registration test first failed with all four `users.*` IDs
absent. Both actual source proof runs then observed the same semantic failures:
the duplicate request overwrote the original with `user-duplicate`; both account reads lost
`passwordHash`; another issuer returned the complete `oidc-primary` account
while `otherStored` was null; and the email collision stored `oidc-conflict`.
Adjacent `Proof:` comments quote those outputs. Each
source then reran the four unchanged registrations successfully.

No user gap was needed. Memory's existing exact
`estimates.set:unknown_step` gap remains unchanged.

## Verification

- Focused inventory: 1 pass.
- Focused memory source: 4 pass, 93 assertions.
- Focused SQLite source: 10 pass, 515 assertions.
- Existing SQLite OIDC repository suite: 5 pass, 12 assertions.
- Conformance target: 29 pass, 47 assertions.
- Memory target: 25 pass, 291 assertions.
- SQLite target: 655 pass, 2,524 assertions across 60 files.
- All six relevant lint/typecheck targets passed, including the missing-family
  compile fixture.
- Formatting, `git diff --check`, OpenSpec strict validation and all 75
  artifacts passed.

## Scope boundary and skips

No capacity, priority-band, calendar-marker or later store family was
implemented. The full workspace, build, browser and deploy gates were skipped
because this slice changes only shared user conformance cases and test-only
fault decorators; it changes no transport, UI, migration or deployment
behavior.
