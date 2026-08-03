<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

<!--
The problem, and why now. 50-1000 characters — OpenSpec's validator enforces
both bounds.

Current pain → why it matters now → what improves. One or two sentences each.
Do not explain the solution here.
-->

## What Changes

<!--
What will be different once this lands. Observable behavior, not implementation.

For before/after, use:

**<Behavior>**
- From: <current>
- To: <future>
- Impact: <breaking / non-breaking, who is affected>
-->

## Non-Goals

<!--
What this change deliberately does not do, and what it must not be extended to
cover. This section is required — an intent without stated non-goals will grow.
-->

## Constraints

<!--
What the solution has to live with. Backward-compatible migrations (blue/green
shares one SQLite file), no CI, amd64 build target, existing contracts —
whatever actually binds this change.
-->

## Capabilities

<!--
The contract with the specs artifact. Every capability here needs a spec file.
Compound nouns, kebab-case: `event-replay`, `deploy-health-gate`.
-->

### New Capabilities

- `<name>`: <one line>

### Modified Capabilities

<!-- Existing capabilities whose REQUIREMENTS change. Use names from openspec/specs/. -->

- `<existing-name>`: <what requirement changes>

## Domain Terms

<!--
Terms resolved during the interview and written to CONTEXT.md. Name only — the
definition lives in CONTEXT.md, not here. Write "none" if none were resolved.
-->

## Decisions Recorded

<!--
ADRs created for this change. Link only; rationale stays in the ADR.
Write "none" if no decision met all three tests (hard to reverse, surprising,
real alternatives existed).
-->

## Impact

<!-- Affected apps, libs, APIs, dependencies, deploy path. -->
