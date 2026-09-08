## Why

The source composition names seventeen transactional stores and two independent saved-plan stores, but the shared suite currently exercises only steps, estimates, directory and event log. Its report records cases as ran when they are merely declared. A moved or partially implemented source can therefore appear certified without executing the contract its consumers depend on.

## What Changes

Define a closed, typed nineteen-family inventory and execute named behavioral cases for the thirteen missing transactional families plus saved-plan history/capture. Preserve the four existing families and case IDs. Reports distinguish declared, executed, passed, failed, not offered and incomplete cases.

Certify each source only for its offered capabilities and named cases. Preserve D29: memory implementations may lag, with exact case exclusions, reasons and observed gap probes. Missing families, unknown exclusions, omitted test bodies and failed setup cannot become passing certification.

Add a named, typed `brokenSource(source, fault)` helper and source-specific fault controls. Every new check is exercised through the actual shared case against an intentionally broken source, with its fault, observation window and assertion recorded after execution.

## Non-Goals

Implementing every lagging memory method; changing storage or HTTP behavior; adding persistence backends; redoing core extraction; certifying unlisted behavior or equating test count with complete correctness.

## Constraints

Run after `core-lib-extraction` establishes source/port ownership and staged memory state. The seventeen-store inventory includes `users: UserStore & OidcIdentityStore` as one family; an accountless source explicitly offers no users capability. Saved history stays outside the command scope. Existing unit-of-work and portable-composition obligations cannot be waived through new exclusions. Bun/Nx only. No new interview is required by the approved plans and this preparation.

## Capabilities

### New Capabilities

- `source-conformance-completion`: complete store-family inventory, capability-specific execution evidence and proved conformance checks.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None; existing ports-plan D22/D29 and core extraction govern source capability boundaries.

## Impact

`libs/conformance`, source-specific test adapters in `libs/store-sqlite` and `libs/store-memory`, their Nx targets and source certification reports. No migrations or application feature changes.
