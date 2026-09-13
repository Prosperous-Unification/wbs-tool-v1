import type { Element } from 'hast';
import type { CSSProperties, ReactNode } from 'react';
import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The plugins the name is parsed with, as one module-level array.
 *
 * `remark-gfm` is here for **strikethrough**, which the spec asks for and
 * CommonMark has no syntax for. It brings GFM's tables and autolinks along with
 * it: a table is a block and is caught by {@link RENDERED_AS_SOURCE} below, and
 * an autolink is an `<a>`, which is the one thing this component already has an
 * opinion about.
 *
 * A constant rather than a literal in the JSX because a new array every render
 * re-parses the source every render, on every row of the table at once.
 */
const INLINE_PLUGINS = [remarkGfm];

/**
 * The source text one parsed element was made from.
 *
 * This is what keeps a name honest. A component that rendered a block's own
 * children instead would silently eat the marker — `# Ship it` would read as
 * the words `Ship it` and nobody would ever learn a `#` had been typed — so
 * every block element renders the characters the parser consumed instead.
 *
 * @throws When the element carries no source position. `react-markdown` parses
 * a string and `mdast-util-to-hast` carries the offsets through, so an element
 * without them is not a name this component can be honest about; a fallback
 * here would be the marker eaten by another route (`AGENTS.md`, R5).
 */
export function blockSourceOf(node: Element | undefined, source: string): string {
  const at = node?.position;
  const from = at?.start.offset;
  const to = at?.end.offset;
  if (from === undefined || to === undefined) {
    throw new Error(
      `InlineMarkdown cannot show the source of a <${node?.tagName ?? '?'}> the parser gave no position`,
    );
  }
  return source.slice(from, to);
}

/**
 * Every tag `react-markdown` can produce that is **not** part of the inline
 * grammar, each rendered as its own source text by {@link blockSourceOf}.
 *
 * The five tags this list deliberately omits are the whole allowlist — `em`,
 * `strong`, `code`, `del`, `a` — plus `p`, which is not passed through either:
 * it is rendered as a fragment, so a cell gets no block box and no margin,
 * which is what keeps a row one line high.
 *
 * The list is written out rather than derived because a tag
 * this map forgets is a marker silently eaten — the exact failure D1 exists to
 * stop. Several entries can only be reached through a parent that is already in
 * this list (`li` under `ul`, `td` under `table`, the `code` inside a `pre`) and
 * so never mount at all; they are listed anyway, because "unreachable" is a
 * claim about today's parser.
 *
 * `img` is here for a reason of its own: a picture is not inline text, and one
 * loaded into a 28px row is a row whose height a name decided.
 */
const RENDERED_AS_SOURCE = [
  'blockquote',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'pre',
  'section',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

/**
 * How a link is drawn in a name: the palette's own ink and an underline, in
 * both faces, so the two readings of one name look like one thing.
 *
 * Not the user agent's link colour, which is `-webkit-link` blue on a light
 * page and a periwinkle nothing names on a dark one — the same fault
 * `dark-mode.spec.ts` holds the header's links to.
 *
 * Exported since 2026-09-09 for {@link ExternalRefsCard}, which draws a link
 * per line and had the user agent's blue on every one of them until it asked
 * here instead. One answer to "how does a link look in this app", in the file
 * that first needed one.
 */
export const LINK_INK: CSSProperties = { color: 'var(--primary)', textDecoration: 'underline' };

/** What a link renders as, which is not the same on every face — see {@link InlineMarkdownProps}. */
interface LinkProps {
  href?: string | undefined;
  children?: ReactNode;
}

/**
 * A link drawn inside the grid: followable by a pointer and invisible to Tab.
 *
 * **It was a `<span>` until 2026-08-30**, on the reasoning that the Name cell's
 * own click opens the editor and an anchor inside one would put a second click
 * target in the cell and a tab stop in the grid's matrix of cells. Dany
 * reversed the first half — _"can you make the links in markdown of the
 * workitem clickable"_ — having drawn a link in a name and found there was no
 * way to follow it from the face it is read on.
 *
 * The second half stands, and this is how both are kept:
 *
 * - `tabIndex={-1}`, so Tab still steps from a name to the next column rather
 *   than into a link inside it. The grid's tab order is a matrix and a link
 *   somebody typed is not a cell in it.
 * - `pointer-events: auto` on the anchor alone (`styles.css`), against the
 *   `none` its box carries: a click on the **link** follows it, a click
 *   anywhere else in the cell falls through to the box under it and opens the
 *   editor, exactly as before.
 *
 * The drawn box is `aria-hidden`, so this anchor is not the accessible route to
 * the link and is not meant to be — {@link LinkFollowable} on the hover preview
 * is, and it is a real tab stop on a real card.
 *
 * `noopener` beside `noreferrer` although the latter implies it in every
 * browser this ships to: the pair is what `external-refs` writes down as the
 * rule for a followable external link, and one spelling is cheaper than two.
 */
function LinkInGrid({ href, children }: LinkProps) {
  return (
    <a
      data-name-link
      href={href}
      data-fact={href}
      style={LINK_INK}
      target="_blank"
      rel="noreferrer noopener"
      tabIndex={-1}
      // **A bare click belongs to the cell, not to the link.** Dany asked for
      // followable links on 2026-08-30 and then, having used them, for
      // `⌘/Ctrl+click` only (2026-08-31): a name is a field somebody edits many
      // times for every once they follow something in it, and a plain click
      // that navigated made the commonest gesture the surprising one.
      //
      // The modified click is not handled here at all — it is the browser's own
      // "open in a new tab", which this only has to not swallow. What is
      // cancelled is the unmodified one, and cancelling it is not enough on its
      // own: the anchor takes the pointer (`[data-cell-rendered] a` in
      // `styles.css`), so the textarea underneath never sees the click and the
      // editor would simply not open. {@link openEditorUnder} hands the click
      // on by focusing the box the drawn text is laid over.
      // Proof: this guard removed, so every click is cancelled — `a link in a
      // name is followed by ⌘-click, and edited by a plain one` failed on
      // `browserContext.waitForEvent: Test timeout of 60000ms exceeded`: no tab
      // opened at all, the modified click swallowed with the plain one.
      // Watched in Chromium, 2026-08-31.
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openEditorUnder(event.currentTarget);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Gives a plain click on a drawn link to the cell it is drawn over.
 *
 * The drawn box is `position: absolute` over a `<textarea>` holding the same
 * text, and `[data-cell-rendered]` takes no pointer *except* on an anchor — so
 * a click the anchor cancels stops there and reaches nothing. Focusing the box
 * is what "the click opened the editor" means everywhere else in the grid.
 *
 * Throws rather than shrugging if the box is not there (R5): the drawn box only
 * exists as a sibling of the textarea it draws, so its absence is a broken
 * invariant and not a state to render around.
 */
function openEditorUnder(link: HTMLAnchorElement): void {
  const drawn = link.closest('[data-cell-rendered]');
  const box = drawn?.parentElement?.querySelector('textarea, input');
  if (!(box instanceof HTMLElement)) {
    throw new Error('a drawn link has no cell box under it to give the click to');
  }
  box.focus();
}

/** A link on a face that has room for one: the hover preview's, title and notes alike. */
export function LinkFollowable({ href, children }: LinkProps) {
  return (
    <a
      data-name-link
      href={href}
      data-fact={href}
      style={LINK_INK}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

/**
 * The components map for one name: what the parser is allowed to make of it.
 *
 * Built per source string because {@link blockSourceOf} needs the source to
 * slice — the map is the only place the two meet.
 */
function inlineComponents(source: string, linksFollowable: boolean): Components {
  const asSource = ({ node }: { node?: Element }): ReactNode => blockSourceOf(node, source);
  // Collected into a record of its own and spread, rather than assigned one key
  // at a time into a `Components`. `components[tag] = …` with `tag` a union of
  // twenty-three tag names makes the compiler build the union of twenty-three
  // prop types, and it refuses: `TS2590: Expression produces a union type that
  // is too complex to represent`. Every value here is the same component, which
  // reads only `node` — so the record says that once instead of per key.
  const blocks: Partial<Record<(typeof RENDERED_AS_SOURCE)[number], typeof asSource>> = {};
  for (const tag of RENDERED_AS_SOURCE) blocks[tag] = asSource;
  return {
    ...blocks,
    // The wrapper markdown always makes, rendered as a fragment: no block box,
    // no margin, and so no height of its own in a cell.
    p: ({ children }) => <>{children}</>,
    a: linksFollowable ? LinkFollowable : LinkInGrid,
  };
}

export interface InlineMarkdownProps {
  /** The name, as it is stored: the raw source, never composed into a larger document. */
  children: string;
  /**
   * Whether a link is an anchor somebody can follow.
   *
   * False everywhere the name is drawn inside the grid — see
   * {@link LinkAsText} — and true on the hover preview, which is a card with
   * room for a click of its own.
   */
  linksFollowable?: boolean;
}

/**
 * A work item's name, read as **inline** markdown: emphasis, strong, inline
 * code, strikethrough and links, and nothing else.
 *
 * One component for all four faces — the Name cell at rest, the hover preview's
 * heading, the plan cards and the chart's row label — because a rule spread
 * across four renderers is four rules that agree until one is edited.
 *
 * Block syntax does not parse: a `#`, a `-`, a `>`, a fence, a table or a rule
 * renders as the characters somebody typed, through {@link blockSourceOf}. Raw
 * HTML is text for the reason `hover-preview.tsx` gives about notes —
 * `react-markdown` renders React elements and passes no HTML through, and there
 * is no `rehype-raw` here either.
 *
 * The name is passed as the **whole** source, never concatenated into a larger
 * document. Where a heading is wanted, the heading is an element the caller
 * writes around this one: see `hover-preview.tsx`.
 */
export function InlineMarkdown({ children, linksFollowable = false }: InlineMarkdownProps) {
  const components = useMemo(
    () => inlineComponents(children, linksFollowable),
    [children, linksFollowable],
  );
  return (
    <Markdown remarkPlugins={INLINE_PLUGINS} components={components}>
      {children}
    </Markdown>
  );
}

/**
 * A name, drawn the way a grid draws it — the argument `CellInput`'s
 * `renderFirstLine` takes.
 *
 * A module constant rather than a lambda at each call site for two reasons, one
 * of them load-bearing: `columns` in `wbs-table.tsx` must depend on nothing that
 * is rebuilt per render, or every cell remounts and the focus is lost
 * (`LLM_README.md`'s first landmine); and the table and the phone's cards draw
 * a name the same way because it is the same function, not because two call
 * sites agree today.
 */
export const renderName = (name: string): ReactNode => <InlineMarkdown>{name}</InlineMarkdown>;
