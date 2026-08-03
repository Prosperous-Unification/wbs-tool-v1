<!--
Delta spec template for a change.

This template demonstrates 4 delta section types; use as needed:
- ADDED / MODIFIED / REMOVED / RENAMED
Filename and location: openspec/changes/<change-name>/specs/<capability>/spec.md
(`<capability>` aligns with the openspec/specs/<capability>/ directory name)

Format hard rules (OpenSpec will validate):
- Requirement sentence MUST contain `SHALL` or `MUST`
- Each Requirement MUST have at least one `#### Scenario:`
- Scenario MUST use level-4 (`####`); level-3 or bullets will silent-fail
-->

## ADDED Requirements

<!-- New behavior. List the new Requirements this change adds to the capability. -->

### Requirement: <!-- requirement name -->

<!-- requirement text — must contain SHALL or MUST -->

#### Scenario: <!-- scenario name -->

- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## MODIFIED Requirements

<!--
Modify an existing Requirement. **MUST use the exact same normalized header
as in openspec/specs/<capability>/spec.md** (case-sensitive after trim);
otherwise the delta apply at archive time will fail because the
corresponding requirement cannot be found.

**MUST paste the complete modified content** (not just the diff), because
OpenSpec archive applies MODIFIED via full-text replacement.
-->

### Requirement: <!-- same header as in the existing spec -->

<!-- complete modified requirement text — containing SHALL or MUST -->

#### Scenario: <!-- scenario name (may be added or modified) -->

- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## REMOVED Requirements

<!--
Delete an existing Requirement. MUST include Reason and Migration so
reviewers understand why it is deprecated and how existing callers should
migrate.
-->

### Requirement: <!-- the header to remove, identical to the existing spec -->

**Reason**: <!-- why deprecated -->

**Migration**: <!-- how existing callers / dependents should adjust -->

---

## RENAMED Requirements

<!--
Rename a Requirement header. Format is fixed: FROM / TO use code-fence headers.
If both name and content change, **simultaneously** list the rename in
RENAMED, and write a complete content section under the **new** header in
MODIFIED.

Apply order at archive time: RENAMED → REMOVED → MODIFIED → ADDED
-->

- FROM: `### Requirement: <Old Name>`
- TO: `### Requirement: <New Name>`
