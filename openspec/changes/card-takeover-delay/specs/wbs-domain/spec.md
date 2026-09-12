## ADDED Requirements

### Requirement: An open card gives way only to a rested pointer

While a hover card is open, a different cell's trigger SHALL take it over only after the pointer
has rested on that trigger for the takeover delay. Arriving on the open card SHALL drop a pending
takeover; leaving the trigger SHALL drop it too. With no card open, a trigger SHALL open its card
at once. The rule SHALL be the same for every kind of card.

#### Scenario: the hand crosses a live trigger on its way to the card

- **GIVEN** a notes preview open from its marker, and a Depends cell with a dependency beside it
- **WHEN** the pointer moves in steps across that Depends cell and onto the preview
- **THEN** the preview SHALL still be open when the pointer arrives
- **AND** the Depends cell's card SHALL not have opened

#### Scenario: a pointer that rests takes over

- **GIVEN** a notes preview open
- **WHEN** the pointer rests on a Depends cell that has a dependency for longer than the takeover
  delay
- **THEN** that cell's card SHALL be open and the preview closed

#### Scenario: nothing open, nothing waits

- **GIVEN** no card open
- **WHEN** the pointer enters a trigger
- **THEN** its card SHALL open at once

#### Scenario: a takeover left behind still lets the reach close the first card

- **GIVEN** a card held by the reach, and the pointer on another trigger inside the takeover delay
- **WHEN** the pointer leaves that trigger for somewhere that opens nothing
- **THEN** no takeover SHALL happen
- **AND** the first card SHALL close when the reach runs out
