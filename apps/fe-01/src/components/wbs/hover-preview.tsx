import type { CSSProperties } from 'react';
import Markdown, { type Components } from 'react-markdown';

import { HoverCard } from './hover-card';
import { InlineMarkdown, LinkFollowable } from './inline-markdown';

export interface HoverPreviewProps {
  /** Told when the pointer arrives on the card — see {@link HoverCardProps.onPointerArrives}. */
  onPointerArrives?: () => void;
  /**
   * The work item's name, shown as the heading — its own source, never composed
   * into a larger markdown document. See {@link HoverPreview}.
   */
  name: string;
  notes: string;
  /** Named in the popover so a hover on a busy table says which row it belongs to. */
  number: string;
}

/**
 * The rendered reading of one work item, shown on hover over its Name cell:
 * the name as a level-one heading, the notes as markdown under it.
 *
 * At rest the cell shows the name alone and the notes take no height, so this
 * is where a note is read at all — and the name is repeated here because a
 * preview of the notes on their own is a page of text with no title, hanging
 * beside a row whose name it does not say.
 *
 * **The heading is structure this file writes; the emphasis inside it is
 * content the parser made, and the two never meet as a string.** The name goes
 * through {@link InlineMarkdown} *inside* an `<h1>` this component renders —
 * never `<Markdown>{`# ${name}`}</Markdown>`. Composing the name into the
 * markdown source would be a second parser over the whole field: a name
 * starting with `#`, or holding an underscore or a bracket, would read here as
 * something other than what the cell shows, and nothing the name contains can
 * produce, close or escape an element this file writes itself.
 *
 * That half of `name-title-body`'s reasoning stands. The other half — "a field
 * nobody writes markdown in" — was wrong about the field, and is reversed by
 * `markdown-work-item-names` (Dany, 2026-08-29): a name carrying `**blocked**`
 * or a link reads as one, on this face and on the three others, all four
 * through the same component. Only the **inline** grammar parses; a `#` in a
 * name is still the character somebody typed.
 *
 * A link is a **tab stop** here and nowhere else — see
 * {@link InlineMarkdownProps.linksFollowable}: this is a card with room for a
 * click of its own, and the one face where the anchor is not `aria-hidden`. In
 * the grid a link is followable by pointer alone (`LinkInGrid`), because the
 * grid's tab order is a matrix of cells and a link somebody typed is not one.
 * The notes under the heading are drawn through the same link component as the
 * name above it, which is the whole of "the title's links and the body's are
 * one thing" (Dany, 2026-08-30).
 *
 * `react-markdown` renders to React elements and does **not** pass raw HTML
 * through — no `rehype-raw` here, deliberately. Notes are written by one
 * person and read by everyone else on the project, so a note containing a
 * `<script>` or an `onerror` attribute must render as the text somebody typed
 * and nothing else. That is the whole reason this is a markdown renderer
 * rather than `dangerouslySetInnerHTML` over a converted string.
 */
/** The name's own size, which every heading a note makes stays under. */
const NAME_SIZE_EM = 1.3;

/**
 * A note's headings, sized under the name.
 *
 * The browser's defaults are sized for a page — `h2` is 1.5em — and the name
 * above the notes is not a page's `h1`: left at defaults, a note opening with
 * `## Risks` read as the preview's title and the name as its footnote. The
 * elements keep their levels (an `h2` stays an `h2`; the first test asserts
 * it), only their size is brought under {@link NAME_SIZE_EM}, in their own
 * order. `h4`–`h6` default to 1em and below, already under all of these.
 *
 * Proof: the `h2` entry deleted, `the name out-sizes every heading a note
 * makes` failed on `expected 1.15 to be greater than NaN`; the `h1` entry
 * deleted, on `expected 1.3 to be greater than NaN` — a note heading with no
 * declared size is one the browser sizes over the name. Watched, 2026-08-09.
 */
function noteHeadingSized(level: 'h1' | 'h2' | 'h3', fontSize: string): Components[typeof level] {
  const style: CSSProperties = { fontSize, fontWeight: 600, margin: '8px 0 4px' };
  const Level = level;
  const NoteHeading: Components[typeof level] = (heading) => (
    <Level style={style}>{heading.children}</Level>
  );
  return NoteHeading;
}

const noteHeadings: Components = {
  h1: noteHeadingSized('h1', '1.15em'),
  h2: noteHeadingSized('h2', '1.08em'),
  h3: noteHeadingSized('h3', '1.02em'),
  /**
   * The notes' links, drawn the way the name's are.
   *
   * Left to `react-markdown`'s own `a` until 2026-08-30, which is a bare
   * `<a href>`: the user agent's `-webkit-link` blue on a light page and a
   * periwinkle nothing names on a dark one — the exact fault `LINK_INK` exists
   * for — following in **this** tab, which throws away every unsent draft on
   * the plan behind it, and carrying no `rel`. Dany asked for the title's links
   * and the body's alike, so they are now one component.
   */
  a: LinkFollowable,
};

/**
 * The rendered notes themselves — the name as a heading, the notes as markdown.
 *
 * Lifted out of {@link HoverPreview} on 2026-09-10 so that the panel beside the
 * open editor can be the **same** rendering rather than a second one. Dany:
 * _"the right half of the row is a md preview which is same as in the on-hover
 * md preview"_ — same means one component, or the two drift the first time a
 * mapping is added to either.
 */
export function RenderedNotes({ name, notes }: { name: string; notes: string }) {
  return (
    <>
      {/*
        Sized here rather than left to the browser's default `h1`, which is
        `2em` and would put a name across three lines of a 420px popover.
      */}
      <h1 style={{ fontSize: `${String(NAME_SIZE_EM)}em`, fontWeight: 700, margin: '0 0 4px' }}>
        <InlineMarkdown linksFollowable>{name}</InlineMarkdown>
      </h1>
      <Markdown components={noteHeadings}>{notes}</Markdown>
    </>
  );
}

export function HoverPreview({ name, notes, number, onPointerArrives }: HoverPreviewProps) {
  return (
    // The one card in the table that scrolls, and so the one that takes the
    // pointer: ten lines of notes are taller than any box that may hang over
    // the rows below, and content nobody can scroll to is content the clamp on
    // the cell has hidden twice over. {@link HoverCard} carries the placement,
    // and the reason every other card refuses the mouse.
    <HoverCard label={`Notes for ${number}, rendered`} scrolls onPointerArrives={onPointerArrives}>
      <RenderedNotes name={name} notes={notes} />
    </HoverCard>
  );
}
