## ADDED Requirements

### Requirement: Every external ref carries a name of its own

The system SHALL hold, per external ref, a **name** stated by a reader. The name
SHALL be stored as typed and SHALL NOT be derived from anything the system has
not been told: nothing reads the external system, so no name is ever fetched.

A ref MAY carry no name. That SHALL be a stated absence rather than a failure,
and every surface that shows a ref SHALL then show a label **derived from its
URL** in the name's place — the issue key of a Jira URL, `#` and the number of a
GitHub pull request or issue, the page title of a Confluence page, and the host
for a URL no rule claims.

A ref's name SHALL be edited by the same full replacement that edits its system
and its URL, and undo SHALL restore the name the ref held.

Changing the deriving rules SHALL NOT change a stored name, and SHALL NOT give a
name to a ref that has none.

#### Scenario: a named link keeps the words it was given

- **GIVEN** a work item with one ref named `WCN-3887 Cache warm-up`
- **WHEN** the work item is read back
- **THEN** the ref's name SHALL be `WCN-3887 Cache warm-up`

#### Scenario: an unnamed Jira link reads as its key

- **GIVEN** a stored ref with no name whose URL ends `/browse/WCN-3887`
- **WHEN** it is shown
- **THEN** the label shown SHALL be `WCN-3887`

#### Scenario: an unnamed pull request reads as its number

- **GIVEN** a stored ref with no name whose URL ends `/pull/4178`
- **WHEN** it is shown
- **THEN** the label shown SHALL be `#4178`

#### Scenario: a URL no rule claims reads as its host

- **GIVEN** a stored ref with no name whose URL is `https://example.test/a/b`
- **WHEN** it is shown
- **THEN** the label shown SHALL name `example.test`

#### Scenario: undo puts a name back

- **GIVEN** a work item with one named ref
- **WHEN** the ref list is replaced and the replacement is undone
- **THEN** the ref SHALL carry the name it held before the replacement

### Requirement: The links dropdown is read with the pointer on it

The system SHALL, while the pointer rests **anywhere on** a work item's Links
cell, draw a card that stays on screen while the pointer travels from the cell
onto the card and rests anywhere on it. The whole of the cell SHALL arm the
card, not only the marks drawn inside it.

The card SHALL NOT be painted over by any other cell of the table. It SHALL be
drawn above every pinned body cell, whatever column it opens from.

Each of the card's rows SHALL show the mark of the ref's system family, the
ref's name — or the label derived from its URL — and the ref's URL, and SHALL
tint under the pointer so the row being read is the row being pointed at.

A row's name SHALL be the followable link, and following it SHALL open a new
context and pass no referrer. A ref whose URL is neither `http` nor `https`
SHALL carry no link target on either the name or the URL.

#### Scenario: the card is on top of the table

- **GIVEN** a work item with one ref, and a work item beneath it
- **WHEN** the pointer rests on the first work item's Links cell
- **THEN** the topmost element at the middle of the card SHALL be part of the
  card

#### Scenario: the pointer rests in the cell's own empty room

- **GIVEN** a work item with one ref
- **WHEN** the pointer rests on the Links cell at a point no mark is drawn at
- **THEN** the card SHALL be on screen

#### Scenario: the pointer reaches a link and follows it

- **GIVEN** the card open over the rows below
- **WHEN** the pointer travels from the cell to the card's first row
- **THEN** the card SHALL still be on screen
- **AND** the row SHALL be tinted
- **AND** clicking the name SHALL open the ref's URL in a new context, leaving
  the plan where it was

#### Scenario: a row says what it links to and where

- **GIVEN** a ref named `WCN-3887 Cache warm-up` in Jira
- **WHEN** the card is read
- **THEN** its row SHALL show `WCN-3887 Cache warm-up`
- **AND** it SHALL show the ref's URL
- **AND** it SHALL show a Jira mark

### Requirement: The editor names a link

The system SHALL offer, per ref in the Links editor, a box for the ref's name,
and SHALL offer one on the row that adds a ref.

The add row's name box SHALL be prefilled with the label derived from the URL
being typed while the reader has typed no name of their own, and a name the
reader types SHALL survive a further change to the URL.

Naming a ref SHALL state the whole list, as every other act in this editor does.

#### Scenario: pasting a URL offers its derived label

- **WHEN** a Jira issue URL is pasted into the add row
- **THEN** the name box SHALL hold that issue's key

#### Scenario: a typed name outlives the URL it was typed beside

- **GIVEN** a name typed into the add row
- **WHEN** the URL beside it is replaced
- **THEN** the name box SHALL still hold the typed name
