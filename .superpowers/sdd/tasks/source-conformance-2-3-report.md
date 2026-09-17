# Task 2.3 report — capacity and priority-band source families

## Scope completed

- Added all six manifest cases for project/team capacity and project priority
  ladders to shared registration and the independent implemented-case inventory.
- Exercised complete map/list agreement, composite keys, true absence on clear,
  default and whole-project ladders, missing-reference refusal, and unchanged
  project/team sentinels through both real sources.
- Preserved store/controller responsibility: the kit supplies valid ladders and
  adds no duplicate ladder validation.

## TDD and R5 evidence

The independent inventory first failed with all six IDs absent. SQLite then ran
all six unchanged shared cases. Memory's exact unexcluded refusal cases failed on
the real source: capacity returned two true outcomes and retained both escaped
rows (`Expected - 6 / Received + 14`); priority replacement returned true and
exposed the missing project's ladder (`Expected - 16 / Received + 15`). Those are
now exact case gaps rather than inferred family wildcards.

Both sources then observed the supported composite-key, zero-clear, empty-default
and partial-ladder faults. SQLite additionally observed both missing-reference
faults. Every decorator called the real public store; SQLite's zero mutant used
the real repository write under a connection-local check-constraint bypass so
the readback contained an actual zero row. Adjacent `Proof:` comments record the
observed outputs, and fresh-source restoration passed the same registrations.

## Verification

- Focused inventory: 1 pass.
- Focused memory source: 6 pass, 182 assertions.
- Focused SQLite source: 11 pass, 765 assertions.
- Existing SQLite capacity/priority suites: 17 pass, 34 assertions.
- Conformance target: 29 pass, 47 assertions.
- Memory target: 27 pass, 380 assertions.
- SQLite target: 656 pass, 2,774 assertions across 60 files.
- All six relevant lint/typecheck targets passed, including the missing-family
  compile fixture.
- Formatting, `git diff --check`, OpenSpec strict validation and all 75 artifacts
  passed.

## Scope boundary and skips

No calendar-marker or later source family was implemented. The full workspace,
build, browser and deploy gates were skipped because this slice changes only
shared configuration conformance cases and test-only source decorators; it
changes no transport, UI, migration or deployment behavior.
