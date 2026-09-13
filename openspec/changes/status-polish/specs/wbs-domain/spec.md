## ADDED Requirements

### Requirement: A done bar is outlined and ticked in the status green, with its label clear of the tick

On the Gantt panel a done bar SHALL carry a 2px outline in the status green and its tick SHALL
be drawn in the same green, both as hex literals so the exported SVG keeps them. The green
outline SHALL replace the critical ring on a done bar. The bar's label SHALL leave the tick's
width free at its right end whenever the tick is drawn, so a truncated label ends before the
mark.

#### Scenario: the outline, the tick and the label

- **GIVEN** a done leaf wide enough for its tick
- **WHEN** the chart is laid out
- **THEN** its rect's `stroke` is the status green with a 2px stroke class, its tick's `stroke`
  is the same green, and its label's right padding is the tick's width plus the label pad

### Requirement: A done predecessor is marked wherever the plan names it

Every entry of the Depends card and of the Depends picker list SHALL carry the predecessor's
status and a 3px left border; a done predecessor's border SHALL be the status green and every
other entry's SHALL be transparent, so the lines' text stays aligned.

#### Scenario: one done, one under way

- **GIVEN** a row waiting for a done predecessor and an in-progress one
- **WHEN** its Depends card is open
- **THEN** the done line's border is `3px solid var(--status-done)`, the other's is
  `3px solid transparent`, and both have the same left padding

### Requirement: The lead word of a fact is drawn bold, and in its tone

The hint layer SHALL read two optional mark attributes, `data-fact-lead` and `data-fact-tone`.
When the lead occurs in the fact's words, the layer SHALL draw its first occurrence bold,
coloured by the tone when one is given (`done` → the status green). A lead not found in the words SHALL be drawn as
plain words. The Status cell SHALL set the lead to its status word and the tone to `done` for
a done row.

#### Scenario: Done is bold and green, Unknown bold and plain

- **GIVEN** a done Status cell and an unknown one
- **WHEN** each fact card is open
- **THEN** the first shows `Done` in a `<strong>` coloured `var(--status-done)`, the second
  `Unknown` in a `<strong>` with no colour, and a fact with no lead has no `<strong>`

### Requirement: The Status column is ruled off, listed where it renders, and the tint is faint

The Status column's cells SHALL draw the same right-edge rule the other pinned columns draw.
The Columns control SHALL list `Status` after `Links`. The done tint SHALL be 7% of the status
green over transparent.

#### Scenario: the Columns control follows the table

- **GIVEN** the Columns control open
- **WHEN** its entries are read
- **THEN** `Status` follows `Links`, and `Fact start`, `Fact end` follow `Deadline`
