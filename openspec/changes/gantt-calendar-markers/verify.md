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
