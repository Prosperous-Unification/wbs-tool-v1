<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-09: **"let's fix the links cell … i want hovering on links cell to
open the dropdown with linked items, i can then hover over the dropdown and see
the link's summary + link to click to follow it"**, then **"every link must have
a name — for jira tickets it can be ticket key + summary for example, for PRs it
can be PR# + title"**, and **"make links cell pretty"**.

The card **already opens** and is **invisible**. A pinned `<td>` is sticky with
a `z-index`, so it is a stacking context and a popover inside one is trapped
there while the next cell paints over it. `POPOVER_ROW_LAYER` exists for exactly
this and is handed to the Name column alone — `raiseWhenOpen={columnId ===
'name'}`. Links is pinned too. Measured in Chromium, 2026-09-09: the card's
rectangle is `[94, 229, 284, 68]` and `elementFromPoint` at its middle answers
the _next_ row's name `<textarea>`.

What the card would say is a URL. `work_item_external_ref` holds no title by
design, so every line reads `jira-issue — https://…/browse/WCN-3887` — neither a
summary nor pretty.

## What Changes

- A ref carries a **`name`**: typed by a reader, never fetched. Empty is a
  modeled state and falls back to a label **derived from the URL** —
  `WCN-3887`, `#4178`, a Confluence page's slug, a host.
- The editor names a link: a Name box per row, prefilled from the derived label
  when a URL is pasted.
- The dropdown is redrawn: one row per link, the family's own mark, the name as
  the followable anchor, the system word and the URL beneath it, and a hover
  tint per row.
- Every **pinned** column that opens a popover is lifted over the pinned layer,
  not just `name`.

## Non-goals

- Nothing is fetched. A name is a reader's words about a link, and no column
  anywhere caches an external system's answer.
- Saved plans do not capture a ref's name: `CANONICAL_PLAN_INPUT_SCHEMA_VERSION`
  stays at 1. A snapshot exists to compare schedules, a label moves no date, and
  no path restores a snapshot over live rows, so nothing can lose a name.
- No reordering, no second-level card, no per-ref status.

## Constraints

- The migration is additive and ships a `down.sql`.
- Proof is Chromium: jsdom lays out nothing, and this whole change is layout.
