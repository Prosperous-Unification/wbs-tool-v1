## 1. The reading

- [x] 1.1 `isoToday(today: Date): IsoDate` — the reader's own calendar day, from
      local parts. **Watched red**: written through `toISOString()` and the
      small-hours assertion fails east of UTC.
- [x] 1.2 `todayOffset(axis, today): number | null` — a lookup in the `AxisDay[]`
      the gridlines are drawn from, never a second scale. **Watched red**: a
      clamp in place of the null arm, and the off-chart cases draw a marker.

## 2. The mark

- [x] 2.1 The tinted column, under the gridlines and over the row bands, one day
      wide.
- [x] 2.2 The leading edge, over the gridlines and under every bar, so a bar
      across it reads as begun and not finished.
- [x] 2.3 The axis cell: `aria-current="date"` and the day's number in the
      mark's ink.

## 3. The cases that draw nothing

- [x] 3.1 Today before the plan's first drawn day.
- [x] 3.2 Today after its last.
- [x] 3.3 A plan with no start date — every cell's `date` is null, so the lookup
      finds nothing. **Watched red**: an offset-based placement puts a marker on
      an axis with no calendar.
- [x] 3.4 A weekend is **not** one of these: asserted to land in the gap, with
      the weekend band still under it.

## 4. The gate and the record

- [x] 4.1 `nx affected -t test lint typecheck --base=origin/main` on h2puni, with
      the bun version beside the counts.
- [x] 4.2 `format:check --all` clean.
- [x] 4.3 Spec delta: `wbs-domain`, both requirements leading with `SHALL` —
      `openspec validate` reads only the first line of a requirement body.
- [x] 4.4 `verify.md` with the three watched reds.
- [ ] 4.5 CI green at the head.
