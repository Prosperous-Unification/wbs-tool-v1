# Design

Three things here are not obvious: what replaces a declared table width, why a
flexible column is a set rather than a sentinel, and how one box holds an
estimate and a mention without either reading as the other.

## `width: 100%` plus a minimum, not a total

The table used to be as wide as its columns added up to. That is a table the
window has to fit. It is now `width: 100%` with `min-width: tableMinWidth(...)`
and one column with no declared width, which is a table that fits the window —
until the window is narrower than the state's own minimum, and then the frame
scrolls and the pinned columns hold the left edge exactly as they always have.

`tableMinWidth` is computed per render from the columns actually on screen, and
that is what makes it honest rather than a constant somebody has to remember to
update: two roles folded is `752 + 192 + 200 = 1144`, one of them open is
`752 + 372 + 96 + 200 = 1420`. The first fits a 1280 laptop and the second does
not, and the accordion below is that difference made into behaviour.

`table-frame.test.ts` pins those three numbers and `wbs-table.test.tsx` asserts
the `<table>` carries the one for the state it is in. The browser is what says
the layout **matches** the declaration, which is the half no unit test can
have; the pixels matrix in `e2e/layout.spec.ts` measures it at 1280×800,
1512×982, 900px and 125% zoom.

## A set, not a sentinel

`FLEXIBLE_COLUMNS` is a set of ids the colgroup emits no width for, and
`widthFor` keeps throwing `UnknownColumnError` on its members exactly as it
does on a typo. That is deliberate and it is agy's finding #7: a sentinel width
— `0`, `null`, `auto` — is a plausible number handed to the pinned-offset
arithmetic, which is the two-width-systems bug the whole module exists to make
impossible. Membership is the question to ask instead, and nothing asks
`widthFor` about a flexible column.

Pinning survives because Name is the **last** pinned column: no offset is a sum
that includes it. That is not left to luck — `PINNED_GEOMETRY` throws while the
module is loading if a flexible column is ever put in front of another pinned
one, because such an offset would be right at exactly one window width.

## The accordion

`unfoldedRoles` stays a list — it is what the column builder asks and what the
`columns` memo may depend on — and the writer keeps it to at most one entry.
`columns` depends on `[roles, unfoldedRoles]` and nothing else, permanently:
`flexRender` renders each `cell` as a component type, so a rebuilt definition
remounts every cell and eats the focus. A fold already pays that cost on the
click that asked for it; the accordion pays it once rather than twice.

## One box, an estimate and a mention

Dany asked for one gesture — `2/3/8@ka⏎`, trio typed and Kateryna assigned — so
the folded cell's single box has to hold both. `mention.ts` is the line between
them: `splitMention` cuts at the first `@` and everything downstream of the
estimate half (the draft, `parseTrioShorthand`, the request) reads `estimate`,
while the picker reads `mention`. Without that split a half-typed `@ka` is a
four-part entry the parser refuses, and the cell turns red at somebody who is
doing nothing wrong.

Two consequences are refusals to send rather than repairs, and both are in
`commitCombinedEstimate`:

- A cell left with a mention still in it whose estimate half is **what the cell
  was already showing** commits nothing. `4.8@ka` is a figure this tool
  computed and a search nobody finished, not a request for `4.8/4.8/4.8`. The
  comparison is against `CellInput`'s focus-time baseline, which the commit
  already receives.
- An **empty** estimate half beside a mention commits nothing either. The
  folded cell selects its contents on focus, so `@` typed straight into one
  replaces the figure; committing that as an empty cell would clear an estimate
  nobody touched. Emptying a cell with no `@` in it still clears it, which is
  the gesture the cheat sheet documents.

The same rule puts the figure back on screen: when the mention is taken out —
on a pick, or on the blur that ends the gesture — an empty estimate half is
replaced by what the cell held when the focus arrived.

Escape closes the list and strips nothing, which is what every other picker in
this table does with it. The blur that follows is what removes the fragment,
so nothing stale is left on screen.

## Where the `@` list comes from

`CreatablePicker`'s list is now `PickerList`, exported from the same file and
rendered by both. Three things have to be true of a list that opens over this
table and each of them is a bug the moment two copies disagree: the `mousedown`
that must not blur the box behind it, the `z-index` above every sticky layer in
`table-frame.ts`, and a `top: 100%` measured from a `position: relative`
wrapper inside the `<td>` — which is why the `<td>` itself must not clip, and
why `opensAPopover` now covers role `-final` columns.

The caller keeps the keyboard. The folded cell's Enter takes the first entry
offered, which is `CreatablePicker`'s own rule, and the ordering is what makes
that safe: `Remove <name>` is offered **first on a bare `@` and nowhere else**,
so `@ka⏎` can never be the gesture that unassigns somebody.

## What the folded cell shows

`4.8 · Kat`: the figure (or the box it is typed into) and the person, truncated
with the whole name in the tooltip, in 96px. Where nobody is assigned and the
every-phase rule names somebody, the name is greyed and bracketed — `· (Kat)` —
which is the same reading the unfolded column has always given, moved to the
column that never folds away. Where neither holds, the cell says nothing extra.
