## ADDED Requirements

### Requirement: A row's actions live in one menu

Every row SHALL offer its actions through a single button in the actions
column, labelled with the work item's number, which says that it opens a menu
and whether that menu is open. The menu SHALL hold Duplicate and, on a work
item whose number is not frozen, Delete — and Unfreeze in Delete's place on one
whose number is frozen. Deleting a work item that has children SHALL promote
those children, exactly as the button it replaces did. At most one row's menu
SHALL be open at a time.

#### Scenario: the actions of one row

- **WHEN** a row's actions button is opened
- **THEN** the menu offers Duplicate and Delete, and the button says that its
  menu is open

#### Scenario: a frozen row

- **WHEN** the menu of a row whose number is frozen is opened
- **THEN** it offers Unfreeze in place of Delete, and Duplicate is still there,
  because a freeze pins the number a row left the tool under and the copy is
  given none

#### Scenario: a second menu

- **WHEN** one row's menu is open and another row's actions button is pressed
- **THEN** the first menu closes and only the second is open

#### Scenario: deleting a parent

- **WHEN** Delete is taken on a work item that has children
- **THEN** the children are promoted rather than deleted with it

### Requirement: The menu owns the keyboard while it is open

Opening the menu with Enter, Space or ↓ SHALL move the focus into it, onto the
first item. While it is open, ↑ and ↓ SHALL move the focus between items and
exactly the focused item SHALL be in the tab order; Enter or Space SHALL take
the focused item; Escape SHALL close the menu and give the focus back to the
button it opened from; Tab SHALL close it and let the focus move on, because
the menu is not a focus trap. A press outside the menu SHALL close it.

#### Scenario: opened from the keyboard

- **WHEN** ↓ is pressed on a row's actions button
- **THEN** the menu opens and the first item has the focus

#### Scenario: walking the items

- **WHEN** ↓ and ↑ are pressed in an open menu
- **THEN** the focus moves between the items, and only the item with the focus
  is a tab stop

#### Scenario: changed your mind

- **WHEN** Escape is pressed in an open menu
- **THEN** the menu closes, nothing was asked of be-01, and the focus is back
  on the actions button

#### Scenario: tabbing straight past it

- **WHEN** Tab is pressed in an open menu
- **THEN** the menu closes and the focus carries on out of it rather than being
  held inside

#### Scenario: a click somewhere else

- **WHEN** a press lands outside an open menu
- **THEN** the menu closes

### Requirement: The focus lands somewhere sensible after every action

Taking an item SHALL close the menu and put the focus back on the actions
button, and where a work item was created or removed the focus SHALL then
follow the change: into the copy's Name after Duplicate, and into the Name of
the work item that took the deleted one's place — its next sibling, or the row
above it when it had none — after Delete. A refused request SHALL move the
focus nowhere, leaving it on the actions button.

#### Scenario: after a duplication

- **WHEN** Duplicate is taken
- **THEN** the caret ends up in the copy's Name, ready to be typed into

#### Scenario: after a deletion

- **WHEN** Delete is taken on a row that has a sibling below it
- **THEN** the caret ends up in that sibling's Name

#### Scenario: after unfreezing

- **WHEN** Unfreeze is taken
- **THEN** the focus is back on that row's actions button

#### Scenario: a refused deletion

- **WHEN** Delete is taken and be-01 refuses it
- **THEN** the plan is unchanged, the refusal is on screen, and the focus has
  not moved into any row

### Requirement: The menu opens over the rows, and does not change shape mid-request

The cell holding the actions menu SHALL NOT clip it: the menu SHALL open over
the rows below rather than being cut to a cell one line high. While a request
is in flight the items SHALL remain on screen, shown as unavailable and
refusing to be taken, rather than being removed from the menu.

#### Scenario: the last row's menu

- **WHEN** the menu is opened on a row at the bottom of the table
- **THEN** its items are readable over whatever is below that row

#### Scenario: a menu opened while the table is saving

- **WHEN** an item is taken while a request is already in flight
- **THEN** nothing further is asked of be-01, and the items are still on screen
  saying so
