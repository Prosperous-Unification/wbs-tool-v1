## ADDED Requirements

### Requirement: A reader can name a filter and pick it again later, per browser

A client SHALL let a reader save the filter currently in force — the typed
name plus every ticked facet — under a name of their choosing, and pick a
saved one back up in one gesture that restores both halves together.

Saving SHALL be offered only while the filter is asking something of the plan;
a save while nothing is typed or ticked SHALL be refused, since a view of the
whole plan has nothing to be picked back to.

A saved view SHALL be stored per browser and per project, and SHALL NOT be
sent to, or read from, any server: it is one reader's own named answer to
"what am I looking at", not a fact about the project.

A saved view SHALL be deletable, and deleting one SHALL remove it from
storage as well as from what is offered.

#### Scenario: nothing to name

- **GIVEN** an untouched Find box and no facet ticked
- **THEN** the control to save a view under a name is refused

#### Scenario: a view remembers both halves

- **GIVEN** a typed name and a ticked facet, saved together as one view
- **WHEN** the filter is cleared and the saved view is picked
- **THEN** the Find box and the facet are both restored, exactly as saved

#### Scenario: a saved view is deleted

- **GIVEN** a saved view
- **WHEN** it is deleted
- **THEN** it is offered nowhere and nothing is left of it in storage

### Requirement: The ad-hoc filter is still not remembered across a reload

A client SHALL NOT restore the typed name or any ticked facet after a reload:
the plan a reader opens SHALL be the whole plan. Saved views are the
deliberate opposite — named on purpose, picked on purpose — and their
presence SHALL NOT change this: a saved view SHALL persist across a reload
under its own name, while the ad-hoc filter in force at the moment of saving
SHALL NOT be restored on its own.

#### Scenario: the ad-hoc filter does not survive a reload, even with saved views present

- **GIVEN** a filter typed and ticked, and a saved view already stored
- **WHEN** the page is reloaded without saving the filter in force
- **THEN** the Find box is empty and no facet is ticked, and the saved view is
  still offered by name

### Requirement: A saved view naming something since removed narrows to nothing, not to an error

A client SHALL NOT throw when a saved view's stored criteria name a team, a
person or a phase the project no longer holds, and SHALL NOT silently drop or
repair that criterion. The facet it named SHALL be offered as a ticked
box the reader can see and untick, and narrowing by it SHALL answer with no
rows kept — the same behaviour any other facet gives when nothing on the plan
carries the value asked for.

#### Scenario: a view naming a deleted team

- **GIVEN** a saved view whose stored criteria name a team id no row on the
  plan carries
- **WHEN** the view is applied
- **THEN** the plan narrows to no rows, and the team's box is shown ticked

### Requirement: A malformed saved view is dropped without losing the rest

A client SHALL discard the whole saved-views key, rather than guess at its
shape, where the stored value under it is not a list at all.
Where the stored value is a list but one entry is not a usable saved view —
missing a name, an empty name, or criteria missing a field a filter requires
— that entry alone SHALL be dropped and the other saved views SHALL still be
offered.

#### Scenario: the whole store is not a list

- **GIVEN** a hand-edited value under the saved-views key that is not a list
- **WHEN** the project is opened
- **THEN** no saved view is offered and the key is cleared

#### Scenario: one bad entry among good ones

- **GIVEN** a stored list holding one entry with no name and two entries that
  are complete and valid
- **WHEN** the project is opened
- **THEN** the two valid views are offered and the bad one is not
