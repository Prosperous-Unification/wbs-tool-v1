<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The card nobody could see

- [x] 1.1 `PlanTableCellView` raises **every pinned column that opens a
      popover** over `POPOVER_ROW_LAYER`, rather than `name` alone. The pin is
      read off the layout it is placed by (`layout.pinned`), so a column that
      becomes pinned or unpinned later cannot leave a card trapped again.
      Test: `plan-cells.test.tsx` — `lifts a pinned popover column's cell while
its card is open`, on the Links column.
      Negative: the predicate narrowed back to `columnId === 'name'`; watched
      failing on the Links `<td>`'s own `z-index`.
- [x] 1.2 The browser is the oracle for what the lift is _for_: a card that is
      not painted over.
      Test: `e2e/external-refs.spec.ts` — `the card is on top of the rows below`,
      asserting `elementFromPoint` at the card's own middle is inside the card.
      Negative: the same narrowing; watched failing on the element it answers
      instead.

## 2. A label derived from a URL

- [x] 2.1 `refLabelOf(url)` in `libs/domain/src/external-system/` beside
      `systemOfUrl`: the Jira key, `#` and a GitHub pull/issue number, a
      Confluence page's title segment, a Slack channel, else the host. Pure, and
      total — a URL it cannot parse answers the string it was given.
      Test: `ref-label.test.ts` — one case per rule plus the unparseable one.
      Negative: per rule, the branch removed; watched failing on the label it
      falls through to.

## 3. A ref carries a name

- [x] 3.1 Migration `…_add_external_ref_name`: `ALTER TABLE
work_item_external_ref ADD COLUMN name TEXT NOT NULL DEFAULT ''`, with a
      `down.sql` that drops it. Additive, so blue and green share the file.
      Test: `migrate.db.test.ts` reads the column on a fresh database.
- [x] 3.2 `schema.ts` gains the column with the JSDoc that says why a _typed_
      name is not the fetched title the table refuses. `ExternalRef` and
      `ExternalRefWrite` in `repository/index.ts` gain `name`, the read selects
      it, and the replacement write stores it.
      Test: `external-ref.db.test.ts` — `stores the name a ref was given` and
      `a ref stated with no name reads back as an empty name`.
      Negative: `name` dropped from the insert's values; watched failing on the
      name read back.
- [x] 3.3 `asOptionalExternalRefs` takes an optional `name`: a string, capped at
      `MOST_CHARACTERS_IN_A_REF_NAME`, absent meaning the empty string. A
      non-text or an over-long name is a typed 4xx
      (`externalRefs_entry_name_is_not_text`,
      `externalRefs_entry_name_is_too_long`), never a 500.
      Test: `work-item.controller.test.ts` — `takes a name per external ref, and
bounds its length`, which also records **which** boundary answers what:
      the command shape refuses an unknown key and lets a mistyped value
      through, measured rather than assumed.
      Negative: each guard removed; both watched, and the type one corrected a
      wrong claim in this file's first draft.
- [x] 3.4 `revertTo` carries the name, so an undone replacement restores it.
      Test: `undo.test.ts` — `puts a ref's name back`.
      Negative: the field dropped from the inverse; watched failing on the name.
- [x] 3.5 The wire shapes gain it: `work-item-response.ts` requires `name`,
      `plan-command-shapes.ts` accepts `'name?'`, and the OpenAPI document is
      regenerated.
      Test: `work-item-response.test.ts`, `plan-command-shapes.test.ts`.

## 4. Naming a link

- [x] 4.1 `ExternalRefView` and `ExternalRefDraft` carry `name`;
      `setExternalRefsOf` already sends the draft whole.
- [x] 4.2 The editor grows a Name box per stored row and on the add row. The add
      row's box shows the derived label while the reader has typed nothing, and
      a typed name survives a change to the URL beside it — read rather than
      synced, `addingSystemId`'s own shape.
      Test: `external-refs-modal.test.tsx` — `offers a pasted URL's derived
label` and `keeps a typed name when the URL changes`.
      Negative: the derived arm replaced by `''`; watched failing on the box.

## 5. The dropdown, redrawn

- [x] 5.1 `ExternalRefsCard` draws one row per ref: the family mark, the name
      (or derived label) as the anchor, the system word and the URL beneath, and
      a hover tint. The card takes the pointer per row exactly as it does today.
      Test: `external-refs-card.test.tsx` — the three readings, plus the
      unfollowable URL carrying no target on either the name or the URL.
      Negative: the derived fallback removed; watched failing on the row's text.
- [x] 5.2 The browser is the oracle for the tint and the travel.
      Test: `e2e/external-refs.spec.ts` — `the pointer reaches a link on the
card` and `the pointed row of the card is the tinted one`.
      Negative: the tint rule deleted; watched failing on the computed colour.

## 7. The whole cell, and the click through

- [x] 7.1 The refs cell's button fills the `<td>` and the marks move into a
      12px box inside it, so a pointer resting anywhere in the column arms the
      card. Dany, 2026-09-09: _"i want hover over the whole cell surface to
      trigger the tooltip"_ — the target had been 28×12 inside a 40×26 cell.
      Test: `e2e/external-refs.spec.ts` — `the pointer opens the card from
anywhere in the cell, not just off a dot`, at both corners.
      Negative: the button's `height` back to `MARK_BOX_PX`; watched failing at
      the bottom-right corner.
      Also re-points the existing containment measurement at
      `[data-ref-marks-box]`: measured against a button that now fills the cell
      it was a claim the design could not break.
- [x] 7.2 A real click through the card, because _"i want to then be able to
      hover over the tooltip to click and go to the linked item"_ is three
      browser facts and an `href` assertion is none of them.
      Test: `e2e/external-refs.spec.ts` — `the pointer walks onto the card and
follows a link`, which waits for the popup and reads its URL.
      Negative: `pointerEvents: 'auto'` removed from the card's line; watched
      failing on no tab opening at all.

## 6. Gate

- [x] 6.1 `bun run test:unit`, then the projects this change touches by name,
      then the whole workspace gate, then `bun run e2e` on the shifted ports.
- [x] 6.2 `verify.md` records every command, its result, and the failure-proof
      table.
