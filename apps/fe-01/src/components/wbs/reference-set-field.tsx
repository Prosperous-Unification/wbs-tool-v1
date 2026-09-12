import { useRef, useState } from 'react';

import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';

import { CreatablePicker, type CreatablePickerProps } from './creatable-picker';
import { HoverCard } from './hover-card';
import type { CommitOutcome } from './live-editing';

/**
 * The dimensions this strip draws.
 *
 * `type` is the fourth and the one that never sets `inheritedLabel`: a work item
 * type does not inherit, so there is no ancestor reading for the placeholder or
 * the sheet's `Inherited:` line to show
 * (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`). The field stays
 * optional rather than growing a per-kind type, because the strip's behaviour is
 * "draw it if you were given one" either way, and a union that made it
 * impossible for `type` would be a rule enforced in the one place nobody can
 * read it from — the cell that would have passed it.
 */
export type ReferenceSetKind = 'team' | 'tag' | 'service' | 'type';

export interface ReferenceSetEntry {
  id: string;
  name: string;
}

/** One member in force from above, and the row a reader has to go to to remove it. */
export interface InheritedReferenceEntry extends ReferenceSetEntry {
  /** The stating row, as a reader knows it — `010 Compliance`, never an id. */
  fromRow: string;
}

export interface ReferenceSetAdapter {
  kind: ReferenceSetKind;
  entries: readonly ReferenceSetEntry[];
  ownIds: readonly string[];
  /**
   * The ancestor's set this row reads while its own is empty, in words.
   *
   * Drawn by {@link ReferenceSetSheet} alone, as its `Inherited:` line. The
   * table cell has 120px and says the same thing in the search box's
   * placeholder ink with a leading `↳` — one reading per surface, because two
   * of them in one cell is two of the lines the Tags column grew.
   *
   * **The overriding dimensions' shape**, which since ADR 0008 is teams and
   * services. It cannot describe an accumulating one: "while its own is empty"
   * is the whole of what it says, and a row states `Ready` while carrying `Risk`
   * from `010`. Tags pass {@link inheritedEntries} instead.
   */
  inheritedLabel?: string;
  /**
   * The members in force from above that this row does not state, drawn as chips
   * beside its own.
   *
   * **Chips rather than a placeholder**, because a row that states members of
   * its own still carries these: the box is not empty, so there is no
   * placeholder left to say it in. That is the accumulating dimension's shape,
   * which since ADR 0008 is tags and tags alone — teams and services override,
   * so a row that states any carries none of its ancestor's and
   * {@link inheritedLabel} is the whole of what they need.
   *
   * No adapter passes both: they are the same claim in two shapes, and drawing
   * both put `↳ Risk, Review` and `Inherited: Risk, Review` in one 120px cell on
   * 2026-08-29. The `type` kind passes **neither**, and that absence is
   * load-bearing rather than an omission — a type does not inherit at all
   * (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`), so there is
   * nothing above a row for either field to describe.
   *
   * These wear no ✕ — a member comes off where it was written, and `fromRow` is
   * what the chip's `title` says instead.
   */
  inheritedEntries?: readonly InheritedReferenceEntry[];
  replace: (ids: string[]) => Promise<CommitOutcome>;
  create: (name: string, current: string[]) => Promise<CommitOutcome>;
}

export interface ReferenceSetStripProps {
  label: string;
  adapter: ReferenceSetAdapter;
  dataCell?: CreatablePickerProps['dataCell'];
  gridCell?: CreatablePickerProps['gridCell'];
  addLabel?: string;
  removeLabel?: (entry: ReferenceSetEntry) => string;
  placeholder?: string;
  'data-hint'?: string;
  /** The project fact this box carries, drawn at once where a hint would wait. */
  'data-fact'?: string;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

export const REFERENCE_SET_STRIP_STYLE = {
  display: 'flex',
  // One line, and the callers that want a second one ask for it: a 120px
  // column that wraps is a row that grows a line per chip, which is what the
  // Tags cell was doing on 2026-08-29 (three lines, screenshotted). Both this
  // and the chip group below say `nowrap`, because one wrapping container
  // beside one that does not still wraps.
  flexWrap: 'nowrap',
  alignItems: 'center',
  gap: 4,
  // Shrinks below its content, which is what lets a `nowrap` line clip instead
  // of pushing its cell wider — and, in the Services cell, what lets the strip
  // share a flex line with the mismatch mark beside it. A `flex: 1` was
  // written here for that second case and deleted: taken out, all three
  // Chromium cases still passed, because a flex item shrinks on
  // `flex-shrink: 1` alone and the strip's content is wider than any of these
  // columns. R5 — the guard whose removal cannot be seen does not ship.
  minWidth: 0,
} as const;

/**
 * The truncation cue a clipped rest line wears — the last 14px faded out.
 *
 * The Depends-on cell's own, shared rather than measured twice: `DEP_EDGE_FADE`
 * in `wbs-table.tsx` is this constant, and the reasoning for a fade rather than
 * a `+N` marker is written there. It belongs to **rest** alone on both cells:
 * the picker's list opens inside the element this masks, and a mask over an
 * open directory cuts the list somebody is reading.
 *
 * Spelled from the right edge (`to left … 14px`) rather than as `to right …
 * calc(100% - 14px)`: the same fade, without a `calc()` stop. jsdom 30's CSS
 * model drops a gradient it cannot parse, declaration and all, and the jsdom
 * tests of both cells read this declaration back — with the `calc()` form
 * they could not see the fade at all, on or off.
 *
 * Proof, both cells, 2026-09-06: with this set to `''`, `keeps the truncation
 * fade on the rested strip, and off the open one` failed on `expected '' to
 * contain 'linear-gradient'` and `fades and clips the rest line, and does
 * neither while editing` on `expected '' to contain 'linear-gradient(to left'`.
 */
export const REFERENCE_SET_EDGE_FADE = 'linear-gradient(to left, transparent, #000 14px)';

/**
 * How tall one resting reference strip stands, in px.
 *
 * The strip leaves the flow while it is edited (see {@link ReferenceSetStrip}),
 * so something has to hold the line it was occupying or the row would shrink
 * the moment somebody clicked into a cell — the 2026-08-29 report's own fault
 * with its sign flipped. This is that height, on the anchor.
 *
 * It is a **measurement**, not a preference: the resting strip is as tall as
 * the search box in it, which is Chromium laying out a 14px `input` with this
 * table's padding and border. A constant that quietly disagreed with the real
 * one would clip the rest line by the difference, and silently — every style
 * assertion about the anchor is written against this same number. So
 * `e2e/reference-cells.spec.ts` measures the painted anchor against the
 * painted strip instead, and fails when the two part company.
 */
export const REFERENCE_SET_LINE_HEIGHT = 24;

/**
 * Where an open panel sits in the stack.
 *
 * Above every layer `table-frame.ts` gives a pinned or sticky cell (4 is its
 * highest) and below the `PickerList`'s own 15, which opens **inside** this
 * panel: a list that its own panel painted over would be a directory nobody
 * can read.
 */
const REFERENCE_SET_PANEL_LAYER = 10;

export const REFERENCE_SET_ADD_CLASS =
  'shrink-0 border-0 bg-transparent text-xs hover:bg-[color-mix(in_oklab,var(--foreground)_7%,var(--cell-bg))] hover:text-foreground';
export const REFERENCE_SET_CHIP_CLASS =
  'bg-muted inline-flex max-w-full items-center gap-0.5 rounded px-1 text-xs';
export const REFERENCE_SET_REMOVE_CLASS = 'shrink-0 border-0 bg-transparent p-0';
/**
 * The inherited chip's ink: the own chip's box, dimmed and outlined instead of
 * filled.
 *
 * A reader has to be able to tell, at a glance and without a pointer, which
 * words this row wrote and which it is carrying — that is the whole of what
 * `tags-accumulate` adds to a cell, and a chip that looked the same would make
 * the accumulation a lie about who said what. `border-dashed` rather than a
 * second fill because the filled `bg-muted` is already the row's own, and two
 * fills in one 120px cell read as two kinds of value rather than one value in
 * two states.
 */
export const REFERENCE_SET_INHERITED_CHIP_CLASS =
  'text-muted-foreground border-muted-foreground/40 inline-flex max-w-full items-center gap-0.5 rounded border border-dashed px-1 text-xs';

/** One line of {@link ReferenceSetStrip}'s hover card. */
interface ReferenceSetLine {
  /** Stable within one card — the React key. */
  key: string;
  text: string;
  /** Whether this row wrote the member, as against carrying it from above. */
  stated: boolean;
}

/**
 * Everything a reference cell means, one line each, in the order the strip
 * draws it — what the hover card says.
 *
 * The card exists because the rest line is **one clipped line**: a 120px column
 * fits about two chips, the fade at its end announces that the rest was cut,
 * and until 2026-08-31 there was no way at all to read what had been cut
 * without clicking into the cell and opening a panel over the rows below. Dany,
 * that day: *"cannot hover over tags cell to see the list of tags"*. The
 * Depends-on cell has said the same thing with a {@link HoverCard} since
 * `dep-hover-highlights`; this is the other four cells joining it.
 *
 * The three sources are the three things a cell can draw, and each is included
 * on exactly the terms the cell draws it on, so the card is the cell unclipped
 * rather than a second opinion about the row:
 *
 * - the members the row **states**, which are its chips;
 * - the members it **carries** as chips beside them, which is the accumulating
 *   dimension — tags (ADR 0008) — and which name the row they were written on,
 *   because that is where a reader has to go to take one off;
 * - the reading an **overriding** dimension makes while the row states none of
 *   its own, which is the box's `↳` placeholder and is therefore drawn only
 *   when {@link ReferenceSetAdapter.inheritedLabel} is given *and* the row is
 *   silent. A row that states a team of its own carries none of its ancestor's,
 *   so a line about one would be a claim the cell does not make.
 *
 * @param own The members this row states, already resolved to names.
 * @param inherited The members in force from above that it does not state.
 * @param inheritedLabel The overriding dimension's ancestor reading, in words.
 * @returns One line per reading, or an empty array for a cell that says nothing.
 */
export function referenceSetLines(
  own: readonly ReferenceSetEntry[],
  inherited: readonly InheritedReferenceEntry[],
  inheritedLabel: string | undefined,
): ReferenceSetLine[] {
  return [
    ...own.map((entry) => ({ key: entry.id, text: entry.name, stated: true })),
    ...inherited.map((entry) => ({
      key: entry.id,
      text: `↳ ${entry.name} — from ${entry.fromRow}`,
      stated: false,
    })),
    ...(own.length === 0 && inheritedLabel !== undefined
      ? [{ key: '(inherited)', text: `↳ ${inheritedLabel}`, stated: false }]
      : []),
  ];
}

/** Shared compact editor for directory-backed work-item reference sets. */
export function ReferenceSetStrip({
  label,
  adapter,
  dataCell,
  gridCell,
  addLabel,
  removeLabel,
  placeholder,
  'data-hint': hint,
  'data-fact': fact,
}: ReferenceSetStripProps) {
  const root = useRef<HTMLSpanElement>(null);
  const ownIds = unique(adapter.ownIds);
  const own = ownIds.map(
    (id) => adapter.entries.find((entry) => entry.id === id) ?? { id, name: id },
  );
  const offered = adapter.entries.filter((entry) => !ownIds.includes(entry.id));
  /**
   * The members in force from above, minus anything this row already states.
   *
   * Filtered here as well as in `effectiveTagsOf` because this strip is also the
   * phone sheet's body and the sheet re-projects `ownIds` while a write is in
   * flight: for the moment between "somebody added `Risk`, which the parent also
   * states" and the tree read that lands it, the two lists would both hold it
   * and the cell would draw `Risk` twice.
   */
  const inherited = (adapter.inheritedEntries ?? []).filter((entry) => !ownIds.includes(entry.id));
  const sourceIdsRef = useRef(ownIds);
  const projectedIdsRef = useRef(ownIds);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  /**
   * Whether the focus is anywhere in this strip — which is the same question as
   * "is the picker's list open", because the box opens its list on focus and
   * discards it on blur. The chips' own ✕ buttons count: somebody removing
   * members is editing this cell as much as somebody typing into it.
   */
  const [editing, setEditing] = useState(false);
  /**
   * Whether the pointer is on this cell — which is the same question as "is the
   * hover card open", subject to the two conditions on it below.
   *
   * Local to the strip rather than routed through the table's `hoveredCell` the
   * way the Depends-on card is, and that is the point of putting the card here:
   * four cells across two renderers get one card from one place. The table's
   * state exists to settle a card against a **refreshed tree** — its key is a
   * row id, so a card open on a row that moved would follow the row away from
   * the pointer — and this card has no such key: it is a child of the cell it
   * describes, so a re-render moves the two together or unmounts both.
   */
  const [pointed, setPointed] = useState(false);
  /**
   * Wrapping is for the chips, and only while somebody is editing them.
   *
   * At rest the cell clips (see the strip's `overflow` below) and one line is
   * the whole of it — a 120px column cannot afford a line per chip, and
   * growing every row that states three tags was the 2026-08-29 report. While
   * the cell is being edited the chips wrap into reach instead, because a chip
   * clipped out of sight is a member nobody can take off. An **empty** cell
   * never wraps: it has nothing to wrap, and the wrap is what made the
   * Depends-on cell two lines tall the moment it was clicked into
   * (`deps-single-line`, measured in Chromium).
   *
   * **`own` and not `own` plus the inherited chips**, and that is the rule
   * rather than an oversight: the wrap exists to put a ✕ back in reach, and an
   * inherited chip has none. A cell that carries three inherited tags and states
   * nothing has nothing anybody could act on hiding behind the clip, so it stays
   * on the line it rests on and the panel does not open a row taller than it
   * needs to be.
   *
   * Proof, three faults, all watched 2026-08-29 in
   * `reference-set-field.test.tsx`. Forced to `false`, `wraps both containers
   * only while a crowded cell is edited` failed on `expected 'nowrap' to be
   * 'wrap'`; widened to `editing` alone, `keeps an empty cell on one line
   * while it is edited` failed on `expected 'wrap' to be 'nowrap'`; and with
   * `'wrap'` written into either container's style at rest — one at a time,
   * because one `nowrap` beside one `wrap` still wraps — `rests every flex
   * container of a crowded cell on one line` failed on `expected 'wrap' to be
   * 'nowrap'` at the strip's assertion and at the chip group's in turn.
   *
   * All four of those are **style** assertions: jsdom computes no layout, so
   * none of them can see a row's height. The layout oracle is
   * `e2e/reference-cells.spec.ts`'s `three tags stand the row taller than a
   * row with none`, where the same two injections were watched in Chromium at
   * `Received: 68.1875` (strip) and `Received: 56` (chip group) against a
   * resting `27.1875`. Watched 2026-08-29, after the jsdom-only round shipped
   * a fix that did not work in a browser.
   */
  const wrapping = editing && own.length > 0;
  const lines = referenceSetLines(own, inherited, adapter.inheritedLabel);
  /**
   * Whether the card is on screen: the pointer is here, the cell is at rest,
   * and it has something to say.
   *
   * **Not while editing**, and that is a rule rather than tidiness. An edited
   * strip is already a panel over the rows below with every chip wrapped into
   * reach, so the card would be a second box saying the same thing over the
   * first — and it would open from the anchor the panel has left, which is a
   * card standing where the cell no longer is.
   */
  const carded = pointed && !editing && lines.length > 0;
  if (sourceIdsRef.current.join('\0') !== ownIds.join('\0')) {
    sourceIdsRef.current = ownIds;
    projectedIdsRef.current = ownIds;
  }

  const mutate = async (
    project: (current: string[]) => string[],
    commit: (current: string[], next: string[]) => Promise<CommitOutcome>,
  ): Promise<CommitOutcome> => {
    if (pendingRef.current) return 'unsent';
    pendingRef.current = true;
    setPending(true);
    const current = projectedIdsRef.current;
    const next = unique(project(current));
    try {
      const outcome = await commit(current, next);
      // Creation cannot project the server-assigned id. Its unchanged `next`
      // must not overwrite props that refreshed while the create was awaited.
      if (outcome === 'landed' && current.join('\0') !== next.join('\0')) {
        projectedIdsRef.current = next;
      }
      return outcome;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    await mutate(
      (current) => current.filter((ownId) => ownId !== id),
      (_current, next) => adapter.replace(next),
    );
  };

  return (
    /*
      The line the strip stands on, and goes on standing on while the strip is
      not in it.

      An edited strip wraps, and until 2026-08-29 it wrapped **in flow**: the
      cell grew a line per chip, the row grew with it, and every row below moved
      down while somebody was reading the list they had just opened. Dany's
      screenshot of a three-line Tags cell is that. The wrap itself is right — a
      chip clipped out of sight is a member nobody can take off — so what
      changes is where it happens: the strip leaves the flow and opens as a
      panel over the rows below, and this anchor keeps its line.

      `position: relative` as well as the height, because the panel is placed
      against this element. It is **not** the picker's containing block — that
      is the `position: relative` span inside `CreatablePicker`, so the list
      still opens under its own box wherever the panel has put it.
    */
    <span
      data-reference-anchor=""
      // The card's own mark, and the reason it is on the anchor rather than on
      // the strip inside it: the anchor is the element that keeps the cell's
      // line whatever the strip is doing, and it is the `position: relative`
      // box a cell's `HoverCard` is placed against. A `mouseenter` on the strip
      // would be lost the moment the strip left the flow.
      onMouseEnter={() => {
        setPointed(true);
      }}
      onMouseLeave={() => {
        setPointed(false);
      }}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
        // A floor, not a height. At rest the strip stands in this anchor and
        // sets its own height — 24.1875px in Chromium, an input's border and
        // padding included — and a pinned 24 would clip it by the difference.
        // While the strip floats, this is what is left holding the line.
        minHeight: REFERENCE_SET_LINE_HEIGHT,
      }}
    >
      <span
        ref={root}
        data-reference-set={adapter.kind}
        data-reference-strip=""
        // focusin/focusout, which is what React's onFocus/onBlur are: a move
        // between two controls of this strip must not read as leaving it, or the
        // chips would snap back onto one clipped line under the pointer on its
        // way to a ✕.
        onFocus={() => {
          setEditing(true);
        }}
        onBlur={(leaving) => {
          if (!leaving.currentTarget.contains(leaving.relatedTarget)) setEditing(false);
        }}
        style={{
          ...REFERENCE_SET_STRIP_STYLE,
          flexWrap: wrapping ? 'wrap' : 'nowrap',
          // At rest the strip **is** the cell's line, and fills the anchor
          // holding it. While editing it leaves that line — see below.
          flex: 1,
          ...(editing
            ? {
                /*
                  The open panel: out of the flow, over the rows below, opaque.

                  Out of the flow is the fix. The wrap that puts a clipped chip
                  back in reach is real layout while the strip is in flow, so
                  the cell grew and the row grew with it — measured in Chromium
                  on 2026-08-29 at 87.2px against a resting 27.2, and
                  screenshotted by Dany as a Tags cell three lines tall. The
                  anchor above keeps the line; this floats over it.

                  Opaque is what makes it readable rather than merely present.
                  An out-of-flow strip with no background draws its chips over
                  whatever row happens to be under them, which is the same
                  screenshot with a different explanation. `--popover` is the
                  ink the picker's own list uses, so the panel and the list it
                  opens read as one surface.

                  The offsets undo the border and the padding this adds, so a
                  chip sits where it sat at rest rather than stepping down and
                  to the right as the panel opens.
                */
                position: 'absolute' as const,
                top: -1,
                left: -2,
                zIndex: REFERENCE_SET_PANEL_LAYER,
                /*
                  Its own column's width, and never a pixel of the one beside
                  it. A panel sized to its content (`max-content`, capped at
                  240px) covered the Tags cell of the same row while a Teams
                  cell was open, and a click aimed at the neighbour hit the
                  panel instead: `<span data-reference-strip data-reference-set="team">
                  … intercepts pointer events`, watched in Chromium, 2026-08-29.
                  A popover that eats its neighbour's clicks is not an
                  improvement on a row that grew.

                  So it grows **downwards only**. The chips wrap inside the
                  column's own width and the panel hangs over the rows below,
                  which are the pixels a popover is allowed to take. The `+ 4`
                  and the `-2` offset either side undo this panel's border and
                  padding, so a chip sits where it sat at rest.
                */
                width: 'calc(100% + 4px)',
                padding: '0 1px',
                background: 'var(--popover)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 4px 12px oklch(0 0 0 / 12%)',
              }
            : {}),
          // Rest clips and fades; editing does neither. The picker's list is an
          // absolutely positioned child of this element, so a rest-state clip
          // that outlived the focus would cut the directory off at the cell's
          // edge. `editing` is exactly "the list may be open".
          //
          // Proof, two faults, both watched 2026-08-29 by `fades and clips the
          // rest line, and does neither while editing`: `overflow` pinned to
          // `visible` failed on `expected 'visible' to be 'hidden'`, and the
          // mask deleted failed on `expected 'display: flex; flex-wrap: nowrap;
          // ali…' to contain 'linear-gradient(to right, #000 calc(1…'`.
          //
          // Both again in Chromium, which is where clipping is a fact rather
          // than a property: the fade deleted failed `the clipped rest line
          // wears no truncation cue` on `Expected: not "none"`, and
          // `overflow: 'visible'` never reached an assertion at all — the
          // spilled chips cover the cell, and clicking the box timed out on
          // `<td data-column="tag"> intercepts pointer events`.
          overflow: editing ? 'visible' : 'hidden',
          ...(editing
            ? {}
            : {
                WebkitMaskImage: REFERENCE_SET_EDGE_FADE,
                maskImage: REFERENCE_SET_EDGE_FADE,
              }),
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={addLabel ?? `Add a ${adapter.kind}`}
          data-reference-add=""
          className={REFERENCE_SET_ADD_CLASS}
          // Still `disabled` while a write travels, where the search box beside
          // it is only `readOnly` — and the difference is not an inconsistency.
          // The rule is that a control which can hold the focus must not be
          // disabled under it (`creatable-picker.tsx` says why, at length); this
          // one cannot hold the focus at all. `tabIndex={-1}` keeps the keyboard
          // off it and the `preventDefault` below keeps the press off it, and
          // its whole job is to hand the focus to the box.
          disabled={pending}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          // Focus **and then** click. `focus()` alone was a dead press on a box
          // that already holds the focus — which is every press of this `+`
          // straight after adding a value, because a take leaves the focus where
          // it was — and the box's own `onClick` is what opens the list in that
          // state. `creatable-picker.tsx`'s input says the whole of
          // `picker-reopens-on-click`.
          onClick={() => {
            const box = root.current?.querySelector<HTMLInputElement>('input');
            /*
              **A toggle, and the question it asks is about the list.**

              Dany, 2026-09-01: _"can you make it so that clicking second time
              on plus sign for tags/deps on/teams/services hides the add UI"_.
              The `+` opened the picker and had no other state, so a second
              press was a no-op a reader cannot tell from a dead control — and
              the way out was Escape or a click somewhere else, neither of which
              is where the hand already is.

              **`data-searching` and not `aria-expanded`**, and not `editing`,
              and not `document.activeElement`.

              The last two are "the focus is in this cell", which is true in the
              state `picker-reopens-on-click` was written for: the moment after
              a value is taken, the box still holds the focus and the search is
              closed, and the `+` has to open it again from exactly there. A
              toggle reading the focus would close the cell in the one state
              that change exists to fix.

              `aria-expanded` was the first answer and it was too narrow by one
              case. It is `typed !== null && options.length > 0`, so a cell
              whose directory is **empty** — the Types column on any plan where
              nobody has made a type yet — opens for searching with no lines
              under it and reports `false`. The toggle read that as "closed" and
              re-opened what was already open. Dany, 2026-09-03: _"clicking on +
              on types column i cannot click it again to remove the adding type
              UI"_. `data-searching` is `typed !== null` and nothing else, which
              is exactly "the add UI is on screen".

              `blur()` rather than closing the list on its own: the blur is what
              the cell's own `focusout` reads to leave `editing`, so this is the
              same close Escape and a click outside already make, and it
              discards exactly what they discard.
            */
            if (box?.hasAttribute('data-searching') === true) {
              box.blur();
              return;
            }
            box?.focus();
            box?.click();
          }}
        >
          +
        </button>
        <span
          data-reference-chips=""
          style={{
            display: 'flex',
            // The strip's rule, said again here because a `nowrap` strip holding
            // a `wrap` group is still a cell that grows a line per chip.
            flexWrap: wrapping ? 'wrap' : 'nowrap',
            alignItems: 'center',
            gap: 3,
            minWidth: 0,
            maxWidth: '100%',
            /*
              A chip may not paint outside this group, because what is beside
              it is the search box — and the box, being later in the DOM, takes
              the press.

              The group shrinks below its content (`minWidth: 0`, which is what
              lets the line clip rather than widen the column), and a `visible`
              overflow then draws the last chip straight across the box:
              measured live on 2026-08-29 at `chips` 750–835 with a
              `scrollWidth` of 101, the last chip's own box running to 851, and
              the input standing at 839. Clicking that chip's `✕` hit the input
              instead — the browser gate's `<input … aria-label="Tags for 010">
              from <span data-reference-search> subtree intercepts pointer
              events`, a 60s timeout in `round-trips every desktop reference
              set`.

              Clipping here is what the cell already promises: the rest line is
              one clipped line, the fade on the strip says so, and a chip that
              has run out of room is reached by opening the cell rather than by
              aiming at the sliver of it that is still drawn. While the cell is
              open the chips wrap into the panel and there is nothing to clip,
              which is why this follows `wrapping` rather than being pinned.
            */
            overflow: wrapping ? 'visible' : 'hidden',
          }}
        >
          {own.map((entry) => (
            <span
              key={entry.id}
              data-reference-chip={entry.id}
              className={REFERENCE_SET_CHIP_CLASS}
            >
              <span className="truncate">{entry.name}</span>
              <button
                type="button"
                aria-label={removeLabel?.(entry) ?? `Remove ${entry.name} ${adapter.kind}`}
                disabled={pending}
                // Out of the tab order while the rest line clips, the
                // Depends-on cell's rule for the same reason: a sequential Tab
                // can focus a chip that is not on screen, and the browser
                // scrolls an `overflow: hidden` box to show what it focused,
                // shifting a layout nobody asked to move. Tab enters the cell
                // at the box, the box's focus wraps every chip back on screen,
                // and the ✕s are focusable there.
                tabIndex={editing ? undefined : -1}
                // **The press must not take the focus.** Focus here is what
                // makes the strip wrap, and a wrap is a re-layout: Chromium
                // focused this button on `mousedown`, React flushed the
                // discrete update, the ✕ moved from x=690.7,y=154.6 to
                // x=667.7,y=172.5 — onto the second line — and the `mouseup`
                // landed on whatever had taken its place. Measured on the real
                // page, 2026-08-29: `{down: 1, up: 0, click: 0, focusIn: 1}`
                // and not one request sent. A chip's ✕ did nothing at all.
                //
                // The same guard the `+` above carries, for the same reason,
                // and R5 #14/#15's fault class a fourth time: a discrete update
                // inside a mouse gesture that moves the target out from under
                // it. `preventDefault` on `mousedown` suppresses the focus, not
                // the click.
                onMouseDown={(pressed) => {
                  pressed.preventDefault();
                }}
                className={REFERENCE_SET_REMOVE_CLASS}
                // **No focus handoff here, and that is measured rather than
                // assumed.** This button is about to stop existing — the write
                // lands, the row loses the member, React unmounts the chip —
                // and a focused node that is removed hands the focus to
                // `<body>` inside React's own commit, where the `onBlur` is
                // lost exactly as it is for the `disabled` box in
                // `creatable-picker.tsx`. That would strand the panel again.
                //
                // It cannot happen, because this button can never hold the
                // focus: a press does not give it one (the `onMouseDown`
                // above), and the keyboard cannot reach it — Shift+Tab in the
                // box is the **grid's** move, not the browser's. Measured in
                // Chromium, 2026-08-31, with two chips on an open Tags cell:
                // Shift+Tab lands on `Service or team for 010` and the second
                // on `Priority for 010`, never on a `Remove … from 010`.
                //
                // A handoff was written here, could not be watched failing for
                // that reason, and was deleted rather than shipped as a guard
                // nobody can see break — `page-nav.tsx`'s `activeOptions`, and
                // R5's rule about it. The day this cell gets a keyboard route
                // to its chips, the handoff comes back **with** its negative.
                onClick={() => void remove(entry.id)}
              >
                ×
              </button>
            </span>
          ))}
          {/*
            What this row carries without having said it — drawn **after** its
            own members, which is `effectiveTagsOf`'s order and therefore the
            order every face reads.

            Three things make an inherited chip a different thing from an own
            one, and all three are here rather than in a comment: the `↳` a
            reader already knows from the Team cell's placeholder, the muted
            outlined ink, and **no ✕ at all**. A tag comes off where somebody
            wrote it; a ✕ here would have to either edit an ancestor from a
            descendant's cell or do nothing, and both are worse than the
            absence.

            `data-reference-inherited-chip` and not `data-reference-chip`: the
            two are different claims — one is what the row states and the write
            path sends, the other is what it reads — and every existing selector
            that counts a row's own members means the first.
          */}
          {inherited.map((entry) => (
            <span
              key={entry.id}
              data-reference-inherited-chip={entry.id}
              data-fact={`${entry.name} — inherited from ${entry.fromRow}. Remove it there.`}
              className={REFERENCE_SET_INHERITED_CHIP_CLASS}
            >
              <span className="truncate">↳ {entry.name}</span>
            </span>
          ))}
        </span>
        {/*
          The search box takes what the chips leave, and at rest that is
          allowed to be nothing.

          A `minWidth` floor here is a floor on the whole cell: 72px of it in a
          120px column left 34px for every chip the row states, so a cell with
          two tags in it clipped both and a cell with three wrapped onto a third
          line. The floor is real while somebody is typing into the box — a
          search you cannot read what you typed into is not a search — and the
          `+` beside it is what says "add" while the box is shut.

          It holds **nothing**, whatever the set's size. The chips are the value;
          a `restingValue` that printed the sole own member into the box drew
          that member twice in one 120px cell — `Platform ✕ Platform` — and left
          the `add` placeholder beside it unreadable.

          Proof, two faults, both watched 2026-08-29: `minWidth: 72` restored at
          rest, `leaves the whole rest line to the chips until the box is
          entered` failed on `expected 72 to be +0`; `restingValue` restored,
          `draws the sole own member once, as its chip` failed on `expected [
          'Platform', 'Platform' ] to deeply equal [ 'Platform' ]` — a count of
          the **visible** nodes saying it, because both readings answer to one
          accessible name.

          And both in Chromium, where the floor is a width rather than a
          property: `the search box still claims a width floor at rest` failed on
          `Expected: < 72 / Received: 72`, and `the sole own member is drawn more
          than once` on `Expected: 1 / Received: 2`.
        */}
        <span data-reference-search="" style={{ flex: 1, minWidth: editing ? 72 : 0 }}>
          <CreatablePicker
            label={label}
            entries={offered}
            value={null}
            onChoose={(id) =>
              mutate(
                (current) => [...current, id],
                (_current, next) => adapter.replace(next),
              )
            }
            onCreate={(name) =>
              mutate(
                (current) => current,
                (current) => adapter.create(name, current),
              )
            }
            closeWhen={(outcome) => outcome === 'landed'}
            disabled={pending}
            placeholder={placeholder ?? `Search ${label.toLowerCase()}`}
            data-hint={hint}
            data-fact={fact}
            dataCell={dataCell}
            gridCell={gridCell}
          />
        </span>
      </span>
      {/*
        The whole set, unclipped, for a reader who has not clicked into the
        cell — see {@link referenceSetLines}.

        A card that opens from a cell, so no `anchor` and no `beside`: it is an
        absolutely positioned child of this anchor and hangs over the rows
        below, which is the Depends-on card's own placement. It takes no
        pointer (`HoverCard`'s default), so the row underneath still answers a
        click aimed at it.

        The `<td>` this stands in has to be exempt from the grid's clip, or the
        card is cut at the cell's edge — `opensAPopover` in `wbs-table.tsx`,
        which is what `type` joined on 2026-08-31 and what the other three were
        already in for their picker lists.
      */}
      {carded && (
        // Beside the cell rather than under it, on the side with the room:
        // four reference columns stand in the middle of the table, and a card
        // under one covers the rows below it in its own column. See
        // {@link sidewaysPlacement}.
        <HoverCard label={label}>
          {lines.map((line) => (
            <div key={line.key} data-reference-card-line={line.stated ? 'stated' : 'carried'}>
              {line.text}
            </div>
          ))}
        </HoverCard>
      )}
    </span>
  );
}

export interface ReferenceSetSheetProps extends ReferenceSetStripProps {
  open: boolean;
  onClose: () => void;
}

/** Phone presentation of the same directory-set editor. */
export function ReferenceSetSheet({
  label,
  adapter,
  open,
  onClose,
  ...stripProps
}: ReferenceSetSheetProps) {
  if (!open) return null;

  const ownIds = unique(adapter.ownIds);
  const closeAfterLanded = (outcome: CommitOutcome): CommitOutcome => {
    if (outcome === 'landed') onClose();
    return outcome;
  };
  const sheetAdapter: ReferenceSetAdapter = {
    ...adapter,
    replace: async (ids) => {
      const isAddition = unique(ids).some((id) => !ownIds.includes(id));
      const outcome = await adapter.replace(ids);
      return isAddition ? closeAfterLanded(outcome) : outcome;
    },
    create: async (name, current) => closeAfterLanded(await adapter.create(name, current)),
  };

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <ModalContent side="bottom" className="min-h-[60vh]" aria-label={`Edit ${label}`}>
        <button type="button" aria-label={`Close ${label}`} onClick={onClose}>
          ×
        </button>
        <ModalHeader>
          <ModalTitle>Edit {label}</ModalTitle>
          <ModalDescription>Type to search the directory, or add a new name.</ModalDescription>
        </ModalHeader>
        {/*
          Inheritance, in words, and **only here**. A sheet has the room to say
          where a label came from; a 120px cell does not, and says the same
          thing in its box's own placeholder ink with `↳`. Drawing both put
          `↳ Risk, Review` and `Inherited: Risk, Review` in one cell, one under
          the other, which is two of the three lines the Tags column stood at
          on 2026-08-29.

          Proof: this line put back on the strip as well, `draws an inherited
          set once, in the box it is shown but not stored in` failed on
          `expected [ '↳ Core', 'Inherited: Core' ] to deeply equal [ '↳ Core'
          ]` and the sheet's own case on `expected [ 'Inherited: Core from
          010', …(1) ] to deeply equal [ 'Inherited: Core from 010' ]`.
          Watched, 2026-08-29.

          It is a layout fault as well as a duplicate one, and Chromium says
          so: this line has no `nowrap`, so its text wraps inside the strip's
          one line and stands the row up. With it restored, `an inherited set
          stands the row taller than a row with none` failed on `Expected: <=
          27.1875 / Received: 56.5625` — two of the three lines of the
          original report, measured.
        */}
        {adapter.inheritedLabel !== undefined && (
          <p data-reference-inherited="">Inherited: {adapter.inheritedLabel}</p>
        )}
        <ReferenceSetStrip label={label} adapter={sheetAdapter} {...stripProps} />
      </ModalContent>
    </Modal>
  );
}
