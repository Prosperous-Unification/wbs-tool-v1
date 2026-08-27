## ADDED Requirements

### Requirement: Directory-backed reference sets share one cell interaction

The Teams, Tags and Services cells MUST present one interaction family: a quiet
leading add control, compact chips for every label the row states, search,
directory creation, member-at-a-time removal, keyboard selection, and the same
accessible naming and open/close behavior. Each dimension MUST retain its own
directory and write adapter; sharing presentation MUST NOT merge their data.

An inherited set MUST be shown as context while the row's own set is empty.
Adding an own member MUST replace the inherited reading with the row's own set;
removing the final own member MUST reveal inheritance again rather than writing
an explicit "none" state.

#### Scenario: the three directory-backed cells speak one interaction language

- **GIVEN** a row with Teams, Tags and Services columns visible
- **WHEN** a pointer or keyboard user enters each cell
- **THEN** each cell MUST expose the leading add control, search and compact chips in the same order
- **AND** each control MUST name its dimension and work item unambiguously

#### Scenario: a directory-backed value is created and selected

- **GIVEN** a name absent from the selected dimension's directory
- **WHEN** the user takes that dimension's Add line
- **THEN** the directory entry MUST be created idempotently and added to the row's own set
- **AND** no other dimension MUST change

#### Scenario: removing the final own member reveals inheritance

- **GIVEN** a row with an inherited set and one member in its own set
- **WHEN** that own chip is removed
- **THEN** the own set MUST become empty
- **AND** the ancestor's whole set MUST be shown as inherited context

### Requirement: A work item's own team set is writable and schedules as a set

The work-item patch API MUST accept `teamIds` as the row's whole own set. An
absent field MUST leave the set unchanged and `[]` MUST make it unstated. The
write MUST deduplicate ids, refuse an unknown team atomically, journal the whole
before-value for undo, and update `work_item_team` without a migration. A request
MUST NOT send both `teamIds` and legacy `serviceTeamId`; the legacy scalar MUST
remain accepted for one release.

Equivalent team sets MUST store the same id-sorted legacy scalar projection
regardless of request order. Ordinary PATCH is last-writer-wins; revisions MUST
guard undo and redo but MUST NOT be presented as an optimistic PATCH
precondition. Duplicate, delete undo and redo MUST preserve every team
membership. A restore payload written before this change MAY omit the set and
MUST then restore its legacy scalar singleton.

Every effective team with stated capacity MUST contribute one pool to every
slice. The slice MUST start at the earliest instant all pools have room, reserve
its width in each, and clamp width to the smallest stated capacity. An unsized
team MUST label the work without constraining it. Single-team plans MUST retain
their prior dates, float and blocking sets.

#### Scenario: a second own team is added without replacement

- **GIVEN** a row whose own team set is `Platform`
- **WHEN** `Design` is added from the Teams cell
- **THEN** the patch MUST write both `Platform` and `Design`
- **AND** reload MUST return both as removable chips

#### Scenario: one own team is removed without disturbing siblings

- **GIVEN** a row whose own team set is `Platform`, `Design` and `QA`
- **WHEN** the `Design` chip is removed
- **THEN** the patch MUST write `Platform` and `QA`
- **AND** neither surviving member MUST be replaced by an inherited set

#### Scenario: a later full-set write wins without partial state

- **GIVEN** two clients read the same own team set
- **WHEN** each sends a different whole replacement and the second lands last
- **THEN** the second complete set MUST be stored with its stable scalar projection
- **AND** stale undo MUST remain subject to the existing revision refusal

#### Scenario: structural restoration preserves every team

- **GIVEN** a work item with more than one own team
- **WHEN** it is duplicated or restored by delete undo and redo
- **THEN** every own team membership MUST survive
- **AND** an older singleton restore payload MUST remain readable

#### Scenario: a parent set is inherited whole and an own set overrides whole

- **GIVEN** a parent stating `Platform` and `Design`, and a child with no own teams
- **WHEN** the child is read and then given `QA`
- **THEN** it MUST first inherit both parent teams
- **AND** after the write its effective set MUST be `QA` alone

#### Scenario: several capacity pools find a joint window

- **GIVEN** work on two teams whose pools become free at different instants
- **WHEN** the schedule is computed
- **THEN** the work MUST start at the first instant both pools can hold its whole duration
- **AND** its blocking set MUST include every reservation that moved the joint search

#### Scenario: one-team scheduling is unchanged

- **GIVEN** a corpus in which every effective team set has at most one member
- **WHEN** the multi-pool scheduler and current single-pool scheduler are compared
- **THEN** every date, float, blocking set and event-visit claim MUST remain equal

### Requirement: Dependency overflow is pointer-reachable without blocking the page

A Depends-on cell MUST expose its complete stored dependency list in the
anchored card. Moving the pointer from the owner cell to a dependency row in
that card MUST keep the card open. Pointing at a visible chip or card row MUST
highlight only that dependency's work-item row and card line; cell hover or
focus MUST continue to highlight the whole dependency set. Leaving the owner
boundary MUST clear all dependency tint.

The card surface MUST remain `pointer-events:none`; only the smallest dependency
row targets MUST opt into pointer events. Empty card area MUST remain
click-through to the underlying table. Owner leave MUST NOT synchronously
unmount the card while the pointer is crossing passive padding toward a row;
the implementation MUST use a state-only pointer bridge with no capturing hit
box. The existing accessible full-list description MUST remain and card rows
MUST NOT add a redundant sequential tab stop.

#### Scenario: the third dependency is reachable and narrows the tint

- **GIVEN** a cell with at least three dependencies and the full card open
- **WHEN** the pointer travels from the cell onto the third card row
- **THEN** the card MUST stay open
- **AND** only the third dependency's work-item row and card line MUST be tinted

#### Scenario: passive padding does not break owner-to-row travel

- **GIVEN** passive padding separates the owner edge from the first dependency row target
- **WHEN** the pointer crosses that padding on its way to a dependency row
- **THEN** the card MUST remain mounted until the row target is reached
- **AND** the padding MUST remain transparent to clicks

#### Scenario: leaving one card row but remaining in the owner widens again

- **GIVEN** one card row has narrowed the highlight
- **WHEN** the pointer returns to the owner cell without leaving its boundary
- **THEN** every dependency row MUST be highlighted again

#### Scenario: empty overlay space does not intercept a click

- **GIVEN** the card overlaps an actionable cell below it
- **WHEN** the user clicks card space outside every dependency row target
- **THEN** the underlying cell action MUST receive the click

#### Scenario: keyboard users retain one full-list path

- **GIVEN** the Depends-on combobox has stored dependencies
- **WHEN** it receives focus
- **THEN** its accessible description MUST name the complete list
- **AND** card rows MUST NOT enter the sequential tab order

### Requirement: Reference-set editing has phone, theme and persistence parity

At 390×844, Teams, Tags, Services and Depends on MUST expose bottom sheets with
the same own values, inherited context, add/search and member removal available
on desktop. Desktop and phone writes MUST survive reload. Light and dark themes
MUST show every chip and dependency target without clipping, overlap, native
button paint, hidden third values, stale tint or lost focus.

Directory choose/create controls MUST await the write result: they close only
after `landed`, retain the sheet and typed value after refusal, and suppress a
second submission while pending. Member removal MUST keep the sheet open after
all outcomes, retain a refused member, and suppress duplicate pending removal.

#### Scenario: a phone edits every reference-set kind and reloads

- **GIVEN** a 390×844 plan with all four fields visible
- **WHEN** a user adds and removes a member in each sheet and reloads
- **THEN** every landed own set MUST reappear exactly
- **AND** inherited context MUST remain context rather than copied storage

#### Scenario: three values remain readable in both palettes

- **GIVEN** three own values in each directory-backed set and three dependencies
- **WHEN** desktop and phone render in light and dark themes
- **THEN** every value MUST have a reachable full-list or sheet path
- **AND** no control MUST use the browser's native grey button face
