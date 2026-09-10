## 1. Calendar boundary

- [x] 1.1 Add a typed `CalendarRangeError` at `addWorkdays` and a negative unit test.

## 2. Plan read and command guard

- [x] 2.1 Validate the placed latest finish before row date projection.
- [x] 2.2 Return the modeled `calendar_range` read state without partial dates.
- [x] 2.3 Refuse an out-of-range command result inside its unit of work.
- [x] 2.4 Preserve recovery by allowing a command whose resulting plan returns to range.

## 3. Wire and client

- [x] 3.1 Extend the response and refusal contracts.
- [x] 3.2 Explain the range state in the table, Gantt, and exports.

## 4. Verification

- [ ] 4.1 Run focused and full remote gates on h2puni.
- [ ] 4.2 Record the guard-removal negative and exact results in `verify.md`.
