# verify.md — gantt-calendar-markers

Measured results the design deliberately did not fix, recorded where the code
and the tests can both be checked against them.

## The palette, and why every entry sits at one luminance

Eight entries, landed in `libs/domain/src/marker-color.ts` (slice 3.2).

| entry     | fill      | ink       | L       | worst ratio over the 20 backdrops | ink ratio |
| --------- | --------- | --------- | ------- | --------------------------------- | --------- |
| `crimson` | `#f70100` | `#000000` | 0.19796 | 3.1168                            | 4.9592    |
| `amber`   | `#ab6e00` | `#000000` | 0.19810 | 3.1151                            | 4.9620    |
| `olive`   | `#3e8c03` | `#000000` | 0.19787 | 3.1172                            | 4.9574    |
| `forest`  | `#038e3e` | `#000000` | 0.19713 | 3.1079                            | 4.9426    |
| `teal`    | `#0386a5` | `#000000` | 0.19786 | 3.1171                            | 4.9572    |
| `azure`   | `#5d6afe` | `#000000` | 0.19791 | 3.1174                            | 4.9582    |
| `violet`  | `#bb31fc` | `#000000` | 0.19790 | 3.1175                            | 4.9579    |
| `magenta` | `#eb0193` | `#000000` | 0.19790 | 3.1175                            | 4.9581    |

**The luminance is forced, not chosen, and the palette is at the ceiling.** The
darkest light backdrop is `light:pointed+today` (`#c7e1f0`, luminance 0.7242)
and the lightest dark one is `dark:base+weekend+zebra+today` (`#14324c`,
0.02908). Clearing 3:1 against both confines a fill to

    0.18724 <= L <= 0.20810

— a window of about 11% in relative terms, with no room at either end for
lightness to carry any of the distinction between entries. The two constraints
balance at `L = 0.19744`, where the best attainable worst-case ratio over the
whole set is **3.129**. Every entry above is tuned to that luminance at full
chroma for its hue, so the observed worst case of **3.108** is within 0.7% of
the arithmetic ceiling: **no eight-colour palette can do better against this
backdrop set.** Entries are therefore separated by hue and chroma alone, which
is a legibility property this table cannot assert and a browser pixel test can.

**A consequence the plan did not anticipate: all eight take black ink.** The
ink crossover is at `L = sqrt(0.0525) - 0.05 ≈ 0.17913` and the whole window
lies above it, so `labelInk` returns `#000000` for the entire palette. Slice
3.2a's first negative (`labelInk` hard-coded to `'#ffffff'`) is still watched
failing, but the _opposite_ constant — hard-coded to `'#000000'` — agrees with
every row here. That is why the discrimination is proved at both ends of the
sRGB cube and not by this table; see `marker-color.test.ts`, "discriminates at
both ends of the sRGB cube".

## All 160 measured ratios — every entry against every backdrop

| entry     | light:base | light:base+today | light:base+zebra | light:base+zebra+today | light:base+weekend | light:base+weekend+today | light:base+weekend+zebra | light:base+weekend+zebra+today | light:pointed | light:pointed+today | dark:base | dark:base+today | dark:base+zebra | dark:base+zebra+today | dark:base+weekend | dark:base+weekend+today | dark:base+weekend+zebra | dark:base+weekend+zebra+today | dark:pointed | dark:pointed+today |
| --------- | ---------- | ---------------- | ---------------- | ---------------------- | ------------------ | ------------------------ | ------------------------ | ------------------------------ | ------------- | ------------------- | --------- | --------------- | --------------- | --------------------- | ----------------- | ----------------------- | ----------------------- | ----------------------------- | ------------ | ------------------ |
| `crimson` | 4.235      | 3.654            | 4.082            | 3.523                  | 3.742              | 3.266                    | 3.802                    | 3.299                          | 3.569         | 3.117               | 4.760     | 3.980           | 4.326           | 3.464                 | 4.248             | 3.412                   | 3.935                   | 3.118                         | 4.176        | 3.326              |
| `amber`   | 4.232      | 3.651            | 4.080            | 3.521                  | 3.740              | 3.264                    | 3.800                    | 3.297                          | 3.567         | 3.115               | 4.763     | 3.982           | 4.328           | 3.466                 | 4.250             | 3.414                   | 3.937                   | 3.120                         | 4.178        | 3.328              |
| `olive`   | 4.236      | 3.655            | 4.084            | 3.524                  | 3.744              | 3.267                    | 3.804                    | 3.300                          | 3.570         | 3.118               | 4.758     | 3.979           | 4.324           | 3.462                 | 4.246             | 3.411                   | 3.934                   | 3.117                         | 4.174        | 3.325              |
| `forest`  | 4.249      | 3.666            | 4.096            | 3.534                  | 3.755              | 3.277                    | 3.815                    | 3.310                          | 3.581         | 3.127               | 4.744     | 3.967           | 4.311           | 3.452                 | 4.234             | 3.400                   | 3.922                   | 3.108                         | 4.162        | 3.315              |
| `teal`    | 4.236      | 3.655            | 4.084            | 3.524                  | 3.744              | 3.267                    | 3.804                    | 3.300                          | 3.570         | 3.118               | 4.758     | 3.978           | 4.324           | 3.462                 | 4.246             | 3.411                   | 3.933                   | 3.117                         | 4.174        | 3.325              |
| `azure`   | 4.235      | 3.654            | 4.083            | 3.523                  | 3.743              | 3.267                    | 3.803                    | 3.300                          | 3.570         | 3.117               | 4.759     | 3.979           | 4.325           | 3.463                 | 4.247             | 3.411                   | 3.934                   | 3.118                         | 4.175        | 3.326              |
| `violet`  | 4.236      | 3.654            | 4.083            | 3.524                  | 3.743              | 3.267                    | 3.803                    | 3.300                          | 3.570         | 3.118               | 4.759     | 3.979           | 4.325           | 3.463                 | 4.247             | 3.411                   | 3.934                   | 3.118                         | 4.175        | 3.325              |
| `magenta` | 4.236      | 3.654            | 4.083            | 3.523                  | 3.743              | 3.267                    | 3.803                    | 3.300                          | 3.570         | 3.117               | 4.759     | 3.979           | 4.325           | 3.463                 | 4.247             | 3.411                   | 3.934                   | 3.118                         | 4.175        | 3.325              |

Minimum over the whole matrix: **3.1079** (`forest` on
`dark:base+weekend+zebra+today`). Bar: 3:1, WCAG 1.4.11.

## The 20 backdrops, and the four fills they are built from

Resolved values, all derived from `apps/fe-01/src/styles.css` and the four
`fill-*` classes in `gantt-panel.tsx`. `marker-color.test.ts` re-derives the
whole set from `styles.css` and deep-equals it against `MARKER_BACKDROPS`, so
these are checked rather than transcribed.

| source                                 | light     | dark      |
| -------------------------------------- | --------- | --------- |
| `--background`                         | `#ffffff` | `#020618` |
| `--muted-foreground` (weekend, α 0.10) | `#62748e` | `#90a1b9` |
| `--muted` (zebra, α 0.40)              | `#f1f5f9` | `#1d293d` |
| `--grid-dep-lit` (pointed, opaque)     | `#e8ecf1` | `#10182b` |
| `sky-500` (today, α 0.15)              | `#0ea5e9` | `#0ea5e9` |

**`sky-500` is the one that is not read.** It is a built-in Tailwind palette
colour used directly by `fill-sky-500/15` (`gantt-panel.tsx:2955`) and appears
zero times in `styles.css`, so it is pinned as a literal in the test and
recorded here. The other four are read, and a theme change that darkened a band
therefore breaks the test rather than the chart.

| backdrop                   | light     | dark      |
| -------------------------- | --------- | --------- |
| `base`                     | `#ffffff` | `#020618` |
| `base+today`               | `#dbf2fc` | `#041e37` |
| `base+zebra`               | `#f9fbfd` | `#0d1427` |
| `base+zebra+today`         | `#d6eefa` | `#0d2a44` |
| `base+weekend`             | `#eff1f4` | `#101628` |
| `base+weekend+today`       | `#cde6f2` | `#102b45` |
| `base+weekend+zebra`       | `#f0f3f6` | `#151e30` |
| `base+weekend+zebra+today` | `#cee7f4` | `#14324c` |
| `pointed`                  | `#e8ecf1` | `#10182b` |
| `pointed+today`            | `#c7e1f0` | `#102d48` |

## The four pinned vectors — slice 3.1

32-bit FNV-1a over the id's UTF-8 bytes, `mod 8`, against the palette above.
Recorded, not recomputed: a vector the code under test derives at run time is
the code agreeing with itself.

| marker id                              | FNV-1a 32  | index | colour              |
| -------------------------------------- | ---------- | ----- | ------------------- |
| `0f5a1c2e-7b64-4d3a-9e18-2c5f8a41b7d0` | 3786943175 | 7     | `#eb0193` (magenta) |
| `a41b8e62-9d07-4c5b-b3f8-71e2d04a9c6e` | 3195973148 | 4     | `#0386a5` (teal)    |
| `d7e30f45-6a8b-49c1-95d2-08f3b7c61ae9` | 367341714  | 2     | `#3e8c03` (olive)   |
| `88c1e0f7-42ab-4d59-9376-1be5c80f2a34` | 2076945931 | 3     | `#038e3e` (forest)  |

Four distinct colours, so a constant implementation fails on the first row.

## Colours the validator cases and negatives use — slice 3.3

Computed against the backdrop table above and recorded so a later slice does not
re-derive them.

| colour    | L       | failures                 | first failure                  | used by                                                                                      |
| --------- | ------- | ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `#7a3400` | 0.06594 | 10 (every dark backdrop) | `dark:base` at 2.226           | 3.3 case 1 — clears light, fails dark                                                        |
| `#0066ff` | 0.16723 | 3                        | `dark:base+weekend+today`      | 3.3 case 2 — clears both bases, fails a composite                                            |
| `#ff0000` | 0.21260 | 1                        | `light:pointed+today` at 2.943 | 3.3 case 4 — 19 of 20                                                                        |
| `#3a0000` | 0.00854 | every dark backdrop      | `dark:base`                    | 3.2 negative 1 — an entry below 3:1 in dark                                                  |
| `#c00000` | 0.11206 | 9                        | `dark:base+today`              | 3.2 negative 2 — clears bare `dark:base` (3.111) and fails `dark:base+weekend+today` (2.230) |

**Two of these windows are narrow enough to be worth writing down**, because
each is the _only_ place a colour of that shape exists:

- **First failure exactly `dark:base+weekend+today`:** `0.164764 <= L <
0.168028`. Above it `dark:base+zebra+today` (L 0.021588) still passes and
  below it that surface fails first — the two composites are 0.001 apart in
  luminance and `dark:base+weekend+today` is the _lighter_ of the pair, so it
  can never be the worst or the only failure. It is reachable only as the first
  failure in table order.
- **Fails only `light:pointed+today`:** `0.2081 < L <= 0.22005`. Above it
  `light:base+weekend+today` starts failing too, below it nothing fails.

**Neither window is reachable by compositing three tints over `--background`
and stopping there** — both are named by surfaces the pointed row's opaque
light contributes — which is what makes them the cases that prove the validator
measures the whole table rather than the base pair.

## Whole-workspace gate — first recording (item G, half)

`bunx nx run-many -t test lint typecheck`, run on **h2puni** in `~/t235-gate`
with `NX_DAEMON=false NODE_OPTIONS=--max-old-space-size=3072 --skip-nx-cache`
at `7d627f18`, 2026-09-06T08:40:07Z:

```
NX   Running targets test, lint, typecheck for 22 projects
…
NX   Successfully ran targets test, lint, typecheck for 22 projects
```

`fe-01`'s two vitest projects inside that run: **88 files / 2299 passed** and
**2 files / 3 passed**, 0 failed. `be-01` at the same bytes, measured
separately in the same session: **127 files / 1565 passed**, 0 failed. Lint
reports one problem workspace-wide — the pre-existing
`wbs-table.tsx:4748` `react-hooks/exhaustive-deps` warning, **0 errors**.

**A whole-workspace run, and not the sum of the per-project ones**, per
`LLM_README.md`: six import-sort errors reached `main` on 2026-08-30 green in
every per-project run. That is why this line is recorded from `run-many` and
not assembled from the per-slice gates above.

**Item G is not done on this.** G also wants the failure-proof table — for every
negative the plan names, the fault injected, the test that observed it failing,
and the result. What is recorded here is G's first clause at the head that
closed 8.4 and 8.5. **The reason this note originally gave for the table being
impossible — that 8.6, 8.7, 8.8, 3.4 and 7.4 were still open — no longer holds;
see the section below.**

## Failure-proof table — opened (item G, second half)

For every negative the plan names: the fault injected, the test that observed it
failing, and the result.

**The blocker G carried is gone and the transcription is done.** The previous
note on this file said the table could not be complete while 8.6, 8.7, 8.8, 3.4
and 7.4 were open. **3.4, 7.4 and 8.8 are ticked** (run 37, chunks 74–77), and
**8.6 and 8.7 are deferred to TASK-271** by the scope boundary the main session
set on 2026-09-06 — the standalone SVG export, which no acceptance criterion
names.

**What the table is, and what it is not.** One row per fault this task actually
**injected and watched fail**. Every row is transcribed from the chunk section
that recorded it in `backlog/tasks/task-235 - wbs-gantt-calendar-markers.md`,
and the last column names that chunk so a reader can re-read the measurement
rather than take this summary's word for it. A slice absent from the table has
no separately-injected negative of its own: it is carried either by a sibling's
fault (8.5 by 4.1's list case, 6.4 by 6.3's `operateDay` fault) or by a case
whose fault could not be injected in-file, which the chunk section says at the
point it says it — 5.1's negative "as the task specifies it cannot fail" is the
worked example, recorded at run 8 chunk 14 rather than smoothed into a row here.

**The restore discipline every row was run under**, and it is a rule this task
learned the hard way at chunk 50: the fault is applied to the gate tree on
h2puni only, the worktree source held at HEAD, and the file restored **from the
repository, never from a scratch copy** — a `/tmp` copy taken after the
injection restores the injection, and only an md5 against the committed tree
caught `marker-rule-density.ts` still carrying its first fault.

| Slice   | Fault injected                                                                                                                                                               | Test that observed it                          | Result                                                                                                                                                                                                                                                                                                                                              | Recorded in          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 4.1     | `asc(calendarMarker.id)` struck from the `orderBy`                                                                                                                           | the marker repository db suite, `be-01` target | **11 pass / 1 fail** — the tie case alone, on a `toEqual` diff of the two-id sequence                                                                                                                                                                                                                                                               | run 3, chunk 5       |
| 4.1     | The project-existence read struck                                                                                                                                            | same                                           | **11 / 1** — the absent-project case alone, `SQLiteError: FOREIGN KEY constraint failed` where a modelled `not_found` was owed                                                                                                                                                                                                                      | run 3, chunk 5       |
| 4.1     | The duplicate-id read struck                                                                                                                                                 | same                                           | **11 / 1** — the repeated-id case alone, `UNIQUE constraint failed: calendar_marker.id`                                                                                                                                                                                                                                                             | run 3, chunk 5       |
| 4.1     | `one()`'s project scope dropped                                                                                                                                              | same                                           | **11 / 1** — the cross-project case alone                                                                                                                                                                                                                                                                                                           | run 3, chunk 5       |
| 8.0     | The offset body replaced by `calendarDaysBetween(axis[0].date, date)`                                                                                                        | `gantt-panel.test.tsx`, `fe-01` target         | **163 / 4** — `expected 2 to be 9` on the lookup case as predicted, plus the new null case and **two existing today cases**; the today marker's out-of-range arms already caught this fault class, a wrong offset for a date the axis _does_ hold did not                                                                                           | chunk 21             |
| 7.1     | `date: null` → `date: addWorkdays('2026-01-01', workday)` inside `workdayAxis`                                                                                               | `gantt-panel.test.tsx`                         | **164 / 4** — this case on `expected false to be true`; the other three are renders of an undated plan, which narrows the claim rather than voiding it                                                                                                                                                                                              | chunk 22             |
| 7.3     | The click handler's dated branch neutered (`setComposerAt(day.date)` → `void day.date`, `gantt-panel.tsx:4148`)                                                              | `gantt-panel.test.tsx`                         | **181 / 6** — 7.2's two refusal cases and the Space case stayed green, as the plan predicted; the other five are the click-to-open path's own                                                                                                                                                                                                       | chunk 29             |
| 6.5     | `role="status"` removed                                                                                                                                                      | `gantt-panel.test.tsx`                         | **185 / 2** — the Enter and Space cases and nothing else; the click case queries `data-marker-refusal` and could never have caught a missing role                                                                                                                                                                                                   | chunk 31             |
| 6.5     | The role moved to a wrapper with the message in a nested `<span>`                                                                                                            | same                                           | **186 / 1** — the Enter case alone, on the identity assertion; this is what makes "in the region" load-bearing                                                                                                                                                                                                                                      | chunk 31             |
| 6.3     | `operateDay` branching on `<= 1` — the one-marker shortcut the slice exists to prevent                                                                                       | `gantt-panel.test.tsx`                         | **188 / 2** — the one-marker case on `no day sheet — the composer opened instead`, plus 6.4's `is reachable by its role and its name alone`; the two-marker and empty-day cases stayed green                                                                                                                                                        | chunk 32             |
| 6.3     | `ref={focusOnOpen}` removed                                                                                                                                                  | same                                           | **189 / 1** — the empty-day case alone                                                                                                                                                                                                                                                                                                              | chunk 32             |
| 6.3     | The three per-row actions rendered on `index === 0` only                                                                                                                     | same                                           | **189 / 1** — the two-marker case alone                                                                                                                                                                                                                                                                                                             | chunk 32             |
| 6.3     | The Add button's `onClick` emptied                                                                                                                                           | same                                           | **190 / 1** — this case alone; rename, recolour, delete, the three listing cases and 6.1's empty-date composer all stayed green                                                                                                                                                                                                                     | chunk 33             |
| 8.2     | `y2={rowCount}` → `y2={1}`                                                                                                                                                   | `gantt-panel.test.tsx`                         | **199 / 1** — `expected '1' to be '3'`; the order, pointer-events and shared-colour cases do not read the extent                                                                                                                                                                                                                                    | chunk 41             |
| 8.2     | `pointerEvents="none"` deleted from the rule                                                                                                                                 | same                                           | **199 / 1** — `expected null to be 'none'`; the same three stayed green                                                                                                                                                                                                                                                                             | chunk 41             |
| 8.2     | The rule block moved to the **top** of `marksOverLight`, above today's column, the gridlines and the edge                                                                    | same                                           | **199 / 1** — the sequence case alone; the honest-looking fault, since a rule up there is still behind every bar and a "before the bars" assertion would have passed it                                                                                                                                                                             | chunk 42             |
| 8.2     | The rule block moved to **immediately before the bars**, after the row hit lines and the capacity links                                                                      | same                                           | **199 / 1** — the sequence case alone, on slots 8 and 9: what an eight-mark sequence sees and a three-mark one cannot                                                                                                                                                                                                                               | chunk 42             |
| 8.2     | The **assumed** arm of `barClasses` emptied, so the bar paints like a costed one                                                                                             | same                                           | **198 / 3** — this case on `expected false to be true`, plus the two cases already documenting this mutation from 2026-08-12                                                                                                                                                                                                                        | chunk 43             |
| 4.3a    | `openComposerOn`'s `setComposer({ date, … })` routed through `new Date(date + 'T00:00:00').toISOString().slice(0, 10)`, under `TZ=Pacific/Auckland`                          | `gantt-panel.zoned.test.tsx`, zoned tier       | **1 failed / 2 passed** — this case alone and on the **request body**: `"date": "2026-08-19"` against `"2026-08-18"`. The fault reached the create rather than stopping at the axis assertion                                                                                                                                                       | chunk 48             |
| 4.3a    | The **same faulted build** under `TZ=UTC`                                                                                                                                    | zoned tier, both files                         | `gantt-panel.zoned.test.tsx` passes while `zoned-runner.zoned.test.ts` fails both cases (`expected 'UTC' to be 'Pacific/Auckland'`, `expected '2026-08-19' to be '2026-08-18'`) — one run proves the zone on the command line is load-bearing and pays off chunk 47's owed negative                                                                 | chunk 48             |
| 8.3     | The density threshold `>` read as `>=`                                                                                                                                       | the fast tier, 9 / 0 baseline                  | **2 failed / 7 passed** — the boundary case and the six-visible viewport case, the two fixtures with exactly six                                                                                                                                                                                                                                    | chunk 49             |
| 8.3     | `new Set(...)` replaced by `Array.from(...)` and `.size` by `.length`, so density counts markers                                                                             | same                                           | **1 failed / 8 passed** — the seven-markers-one-date case alone                                                                                                                                                                                                                                                                                     | chunk 49             |
| 8.3     | The `dayPx !== FENCE_RUNG_PX` guard deleted                                                                                                                                  | same                                           | **1 failed / 8 passed** — the 12px case alone; the four 4px cases and the 28px case stay green under an unscoped implementation                                                                                                                                                                                                                     | chunk 49             |
| 8.3     | The in-viewport filter dropped from the numerator                                                                                                                            | `gantt-panel.test.tsx`                         | Both halves of the **unscrolled** case fail while the scrolled case stays green                                                                                                                                                                                                                                                                     | chunk 50 (corrected) |
| 8.3     | The rule elements filtered to the visible interval at render time                                                                                                            | same                                           | The **horizon** assertion fails with the document holding six rules instead of thirteen                                                                                                                                                                                                                                                             | chunk 50 (corrected) |
| 8.3     | A fifth fault, watched unbidden while restoring the first                                                                                                                    | same                                           | Fails the **scrolled** half at 7 rules while every other case stays green                                                                                                                                                                                                                                                                           | chunk 50 (corrected) |
| 8.2a    | `vector-effect` removed                                                                                                                                                      | `gantt-panel.test.tsx`                         | **1 failed / 205 passed** — on the helper's diagnostic sentence, `expected 'nothing on the chart at [data-gantt-m…' to be 'non-scaling-stroke'`                                                                                                                                                                                                     | chunk 51             |
| 8.2a    | `strokeWidth={2}`                                                                                                                                                            | same                                           | **1 failed / 205 passed** — `expected '2' to be '1'`                                                                                                                                                                                                                                                                                                | chunk 51             |
| 8.2a    | A `<g data-gantt-marker-rule …>` wrapper carrying the rule's attributes around a `<line strokeWidth={2}>`                                                                    | same                                           | **1 failed / 205 passed** — `expected 'g' to be 'line'`. **Round 18's Critical measured rather than argued:** with the tag assertion removed this renderer paints two CSS columns while passing the width and mechanism equalities, 8.2's order, colour, count, height and pointer cases and every one of 8.3's counts                              | chunk 51             |
| 8.2a    | Alpha dropped from the four-channel clip comparison                                                                                                                          | the 8.2a column-arithmetic suite               | **1 failed / 12 passed** — the alpha-only case (`expected [] to deeply equal [ 2 ]`). The fault that matters most: an anti-aliased hairline's edge columns can move in alpha while RGB stays, so three channels silently shrink a 2-column run to 1, inside the 1-or-2 bound                                                                        | chunk 52             |
| 8.2a    | `isContiguousRun([])` returning `true`                                                                                                                                       | same                                           | **1 failed / 12 passed** — "rejects nothing at all", the lower half of the bound                                                                                                                                                                                                                                                                    | chunk 52             |
| 8.2a    | `sameColumns` as one-directional containment                                                                                                                                 | same                                           | **2 failed / 11 passed**, stated rather than smoothed: one fault reaches both directions of the same missing check                                                                                                                                                                                                                                  | chunk 52             |
| 8.2a    | The two park lines deleted from the gate tree's copy                                                                                                                         | `gantt.spec.ts`, browser tier                  | Fails at `gantt.spec.ts:3899` — `at 28px the marker paints 0…12 and the rule paints 5, 6`. No assertion weakened: the hairline bound, the set equality and the whole-body identity all stand at 28, 12 and 4 px                                                                                                                                     | chunk 56             |
| 9.0     | `markers={markers}` dropped from the host seam                                                                                                                               | the 9.0 fast tier, 19 / 19 baseline            | **5 failed / 14 passed** — every marker case and nothing else                                                                                                                                                                                                                                                                                       | chunk 54             |
| 9.0     | The reread after a write dropped                                                                                                                                             | same                                           | **3 failed / 16 passed** — exactly the three cases that assert a redraw; the read case and the recolour case (which asserts only the store) stay green                                                                                                                                                                                              | chunk 54             |
| 9.0     | The recolour call replaced by `Promise.resolve()`                                                                                                                            | same                                           | **1 failed / 18 passed** — which is what says the four writes are four and not one                                                                                                                                                                                                                                                                  | chunk 54             |
| 9.2a    | `focus-visible:outline-none` **kept** and only the ring classes removed — the fault the slice names, not the obvious one                                                     | the 9.2a browser case                          | The focused cell reads `{"outlineStyle":"none","outlineWidth":"1px","boxShadow":"none"}` and fails `the focused cell draws no indicator`. **The transition assertion passed under the fault**, so the second requirement is the one doing the work; a case written with the transition alone would have shipped green over a cell with no indicator | chunk 61             |
| 9.2c    | `backgroundColor: '#909090'` injected at the chip, after the model was proved against the browser (predicted 2.1687 / 1.9154, returned 2.16873306642071 / 1.915350293503602) | the 9.2c contrast cases                        | The second negative had to be **computed**, not picked: all eight `PALETTE` entries clear 3:1 on both grounds (4.232–4.249 over base, 3.740–3.755 over base-over-weekend), so a separating fill exists only for `0.2589 < L <= 0.3` — a window 13% wide                                                                                             | chunk 68             |
| 8.4     | `pointer-events-auto` struck from the badge's className                                                                                                                      | `gantt.spec.ts`, browser tier                  | **One failed** on `locator.hover: Test timeout of 60000ms exceeded`. Every jsdom assertion in the slice stays green through it: a `pointerenter` dispatched at a detached node proves the handler runs, never that the pixel is reachable                                                                                                           | run 36, chunk 71     |
| 8.8     | The `data-gantt-today-edge` block moved to after the marker-rule map in `marksOverLight` (295 bytes)                                                                         | `gantt-panel.test.tsx`, `fe-01` target         | **2 failed / 217 passed** — 8.8's today case on `expected false to be true`, and 8.2's `is emitted after today's edge…` on the collapsed slot sequence. 8.8's **Saturday** case stayed green                                                                                                                                                        | run 37, chunk 74     |
| 7.4     | `isIsoDate(body.date)` removed from `createProblem`'s create path                                                                                                            | the marker controller db suite, `be-01` target | **1563 pass / 4 fail** — 7.4's workday-number case at `expected 422, received 201` with the row written, plus 4.3's own three date rows. 7.4's second case stayed green                                                                                                                                                                             | run 37, chunk 75     |
| 3.4 (1) | The `validateCustomColor` call removed from the be-01 **create** path                                                                                                        | same                                           | Watched 2026-09-05: the row written while the UI test stayed green                                                                                                                                                                                                                                                                                  | run 37, chunk 76     |
| 3.4 (2) | The `validateCustomColor` call removed from the be-01 **recolour** arm only                                                                                                  | same                                           | Watched 2026-09-05: **23 pass / 1 fail**, `200` where `422` was owed and `#ff0000` stored; the create's contrast case stayed green                                                                                                                                                                                                                  | run 37, chunk 76     |
| 3.4 (3) | The composer's guard removed — the `if (composerColor !== null)` block, 276 bytes, and nothing else                                                                          | `gantt-panel.test.tsx`, `fe-01` target         | **1 failed / 220 passed** — the sub-bar case alone, and on the **request**: `expected [ [ 'p1', { …(4) } ] ] to deeply equal []`                                                                                                                                                                                                                    | run 37, chunk 77     |
| 3.4 (4) | `setComposerRefusal(verdict.message)` replaced by a fixed string, the request still suppressed — a **consumer** fault, not a removal                                         | `gantt-panel.test.tsx`, `fe-01` target         | **1 failed / 221 passed** — the backdrop-naming case alone, on `expected 'That colour cannot be used.' to contain 'light:pointed+today'`; every request-body assertion green                                                                                                                                                                        | run 37, chunk 77     |

Each fault was applied on the gate host only and restored, with the file's md5
compared across both hosts afterwards — `235f3ff2` and `b4d16937` for
`gantt-panel.tsx`, `1ecabd8d` for the marker controller, `f8dd7e0b` for 9.0's
host seam, `0e955b86` and `c9df4943` for 8.2a's spec and panel, `583829ab` for
9.2c's panel.

**The counts in the table are the file's or the tier's, not the workspace's**,
and they move between rows because the suites grew as the task did: 163/4 at
chunk 21 and 199/1 at chunk 41 are the same file twenty cases apart. What each
row asserts is the **shape** of the failure — which cases went red and which
stayed green — and that is what makes the negative worth having. A row's
absolute total is only meaningful against the baseline its chunk section states
immediately above it.

**`calendar-marker.controller.ts` is now `calendar-marker.routes.ts`** (run 38,
chunk 80: the `origin/main` merge ported it onto the framework-free `Route`
shape). The 3.4 and 7.4 rows name the file as it stood when the fault was
injected, which is the honest record; the checks they watched are unchanged and
live in `fieldsFrom`/`createProblem` in the ported module.

## Whole-workspace gate — re-recorded at `41e9de4a` (item G, first clause)

Run 37, chunk 79, 2026-09-06. Supersedes the `7d627f18` recording above, which
was three heads stale by the time 3.4, 7.4 and 8.8 closed.

`bunx nx run-many -t test lint typecheck` on **h2puni**, at the bytes of
`41e9de4a`: **successfully ran targets test, lint, typecheck for 22 projects**,
rc 0.

- `fe-01`, the two vitest projects inside it: **88 files / 2304 passed**, 0
  failed, and the zoned tier **2 files / 3 passed**, 0 failed.
- `be-01`, measured in the same session: **1567 tests across 127 files**, 0
  failed.
- Lint, workspace-wide: **1 problem — 0 errors, 1 warning**, and the warning is
  the pre-existing `wbs-table.tsx:4748` `react-hooks/exhaustive-deps` notice
  about `ownedServicesByTeam` and `teamsByPerson`. Unchanged by this task.

**A whole-workspace run and not the sum of the per-project ones**, per
`LLM_README.md`: six import-sort errors reached `main` on 2026-08-30 green in
every per-project run. That is why this line is recorded from `run-many`.

**G's first clause is therefore current and its second is the table above**,
whose remaining work is transcription of the earlier slices' negatives from
their `## Chunk` sections. **Nothing in G is blocked on measurement any more.**

**This is not a CI verdict.** PR 209 is `CONFLICTING` and no workflow run exists
for this head; see `tasks.md`'s run-37 sections for the cause and the port the
merge needs.

## Whole-workspace gate — at `99d31465`, item G's first clause closed

`bunx nx run-many -t test lint typecheck` on **h2puni** (`~/t235-gate`,
`NX_DAEMON=false`, `--skip-nx-cache`), 2026-09-06T10:18:49Z:

**`NX   Successfully ran targets test, lint, typecheck for 22 projects`.**

- `fe-01`: **88 test files, 2305 passed**.
- `be-01`: **1641 tests across 129 files, 0 failed** (183.02s).
- `mcp-01`: 106 across 7 files. The other tiers: 517/43, 243/20, 178/7, 81/3,
  34/3, 5/1, 2/1.
- Lint workspace-wide: **1 problem, 0 errors, 1 warning** — the pre-existing
  `wbs-table.tsx` `react-hooks/exhaustive-deps` notice, untouched by this task.

**Run at the committed bytes, and that is checked rather than assumed.** md5
equal on both hosts for every file this run touched:
`calendar-marker.routes.ts` `8bdcdce6`, `app.ts` `a3726711`, `openapi.json`
`a5039bdf`, `body-doc.ts` `90ac6d0d`.

This supersedes the `41e9de4a` recording, which was four heads stale by the time
the `origin/main` merge landed. **It is not a CI verdict** — CI run
`34026841948` is in flight at this head, and PR 209 reads `MERGEABLE`
`UNSTABLE`.
