import type { SVGProps } from 'react';

/**
 * What every toolbar icon shares, and why each part of it is load-bearing.
 *
 * - `stroke="currentColor"` and no `fill`: the icon takes the colour of the
 *   control it sits in, so an `outline` button, a `ghost` one and a disabled
 *   one need no icon variant of their own.
 * - `width`/`height` in `em`: it takes the button's font size, so `size="sm"`
 *   and `size="square"` draw the same shape at the size the text beside it
 *   would have been.
 * - `aria-hidden` and `focusable="false"`: every control that carries one of
 *   these already has an `aria-label`, and an icon that named itself as well
 *   would give that control two names. `focusable` is IE/Edge's separate
 *   answer for the same question — an SVG is a tab stop there without it.
 *
 * `viewBox` is the 24×24 grid the three shapes below are drawn on, so their
 * stroke weights match without each one repeating the number.
 */
const ICON: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  width: '1em',
  height: '1em',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: 'false',
};

/**
 * `Arrange by schedule`'s icon: three bars stepping down and to the right.
 *
 * A staircase rather than a sort glyph (`↓≡`, `⇅`), and the difference is the
 * whole point: this control does not sort a column, it puts the rows in the
 * order the bars beside them start. The shape is the chart's, shrunk — a reader
 * who has the Gantt panel open has already seen it.
 *
 * Drawn rather than named, for `KeyboardIcon`'s reason below: a codepoint
 * renders differently on every platform and identically nowhere.
 */
export function ArrangeIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M3 6h8M8 12h9M13 18h8" />
    </svg>
  );
}

/**
 * The cheat-sheet control's icon: a keyboard, drawn.
 *
 * It replaces `⌨` (U+2328), which macOS has no colour presentation for and
 * renders as a hairline outline in the UI font at button size — illegible,
 * reported by Dany on 2026-08-29. The fix is not a different codepoint: the
 * next one has the same class of problem on the next platform. A glyph the app
 * draws renders identically everywhere; a glyph it names does not.
 */
export function KeyboardIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}

/**
 * `Expand all`'s icon: two chevrons pointing **apart**.
 *
 * Apart and together rather than the single down/right chevron a disclosure
 * control uses, because this table already spends that shape on a row: `▾`/`▸`
 * opens and closes one branch. One shape with a per-row meaning and a per-plan
 * meaning is a shape a reader has to disambiguate by position, which is what
 * `design.md` D2 refuses.
 */
export function ExpandIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M7 9l5-5 5 5" />
      <path d="M7 15l5 5 5-5" />
    </svg>
  );
}

/**
 * The Links column's heading: two chain links, drawn.
 *
 * A glyph this file draws rather than one it names, for the reason
 * {@link KeyboardIcon} gives at length: `🔗` (U+1F517) is an emoji presentation
 * on every platform, so it arrives full-colour beside a row of 10px grey
 * all-caps headings and reads as a decoration somebody left in; `⛓` (U+26D3) is
 * the hairline-outline problem the keyboard icon was reported for. A drawn
 * shape takes `currentColor` and the heading's own size.
 *
 * It replaces the word `Links`, which did not fit: the column is 40px and the
 * heading is set in 10px all-caps, so the word ran under the Name heading
 * beside it — reported by Dany with a screenshot, 2026-08-31. The word is still
 * the column's name everywhere a name is read: `COLUMN_LABELS` for the Columns
 * menu, and an `sr-only` span in the heading itself, because an icon that is
 * `aria-hidden` leaves a column heading with nothing to announce.
 */
export function LinkIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** `Collapse all`'s icon: the same two chevrons, pointing together. */
export function CollapseIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <path d="M7 4l5 5 5-5" />
      <path d="M7 20l5-5 5 5" />
    </svg>
  );
}

/**
 * `Project settings`' icon: a gear.
 *
 * The one control on the bar that stands for three (`project-config-modal`, D5):
 * `Teams`, `Priorities` and `Steps` were three labelled buttons somebody uses
 * once and then not for weeks, permanently beside `Add work item` and `Undo` on a
 * bar whose width is the scarce resource. The word moved into the button's
 * `aria-label`, exactly as `Expand all`'s did; the phone's sheet, which has the
 * room, shows the label beside this.
 */
export function SettingsIcon(): React.JSX.Element {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2" />
    </svg>
  );
}
