# `@wbs/validation/fixtures`

The single source of truth for test fixtures across the workspace.

## Usage

```ts
import { injectedClock, makeFrame, makeTestDb } from '@wbs/validation/fixtures';
```

## Conventions (agent-TDD ergonomics — see design D20)

1. Factories, never shared mutable fixtures. `makeX({ override })` pattern.
2. Deterministic clock + RNG — `injectedClock(startMs)` and seeded `fast-check`.
3. No network, no filesystem, no wall clock in unit tests.
4. One assertion concept per test.
5. Test names state invariants, not actions.

See `design.md` D20 for the full list.
