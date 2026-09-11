# Verify

Not started. Designed 2026-09-10 on Dany's ask; implementation has not begun, and this
file is written when it has.

## Failure-proof table

| Check | Fault injected | Test that observed it | Result |
| ----- | -------------- | --------------------- | ------ |

## Measurements

| Figure                                                       | Before the control   | With the control | Pin  |
| ------------------------------------------------------------ | -------------------- | ---------------- | ---- |
| folded toolbar, 1280×900 (`layout.spec.ts`)                  | 1552.73 (2026-08-30) | —                | 1600 |
| `[data-toolbar]` laid out, 1280 (`project-settings.spec.ts`) | —                    | —                | 1265 |

## Fixed point (D10)

Seeds run: —. Counterexamples: —.

## Gate

Pending: the by-name runs, the whole workspace gate, `openspec validate --all --json`, and
the whole browser gate on shifted ports, as `tasks.md` § 7 lists them.
