import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CollapseIcon, ExpandIcon, KeyboardIcon } from './toolbar-icons';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

/** The three, by the name each one is filed under here. */
const icons = [
  ['KeyboardIcon', KeyboardIcon],
  ['ExpandIcon', ExpandIcon],
  ['CollapseIcon', CollapseIcon],
] as const;

/**
 * One icon, rendered where every one of them is really rendered: inside a
 * control that already has a name of its own.
 *
 * Not on its own in a `<div>`, because the whole of what these attributes are
 * for is what they do to the control around them.
 */
function drawInAControl(Icon: () => React.JSX.Element): SVGSVGElement {
  render(
    <button type="button" aria-label="Keyboard shortcuts">
      <Icon />
    </button>,
  );
  const drawn = screen.getByRole('button', { name: 'Keyboard shortcuts' }).querySelector('svg');
  if (drawn === null) throw new Error('the icon rendered no <svg> at all');
  return drawn;
}

describe('the toolbar icons', () => {
  itDom('every icon inherits the colour and the size of the control it sits in', () => {
    // The reason there is no icon variant per button variant, and no icon size
    // per button size: `currentColor` and `em` are what make one drawn shape
    // right inside an `outline` button, a disabled one, and a `size="square"`
    // one — in either palette.
    //
    // Proof: `stroke` in `ICON` changed to the literal `#111827`, this failed
    // on `expected '#111827' to be 'currentColor'` for KeyboardIcon; and
    // `width`/`height` changed to `16`, on `expected '16' to be '1em'`.
    // Watched, 2026-08-29.
    for (const [name, Icon] of icons) {
      const drawn = drawInAControl(Icon);

      expect(drawn.getAttribute('stroke'), name).toBe('currentColor');
      expect(drawn.getAttribute('width'), name).toBe('1em');
      expect(drawn.getAttribute('height'), name).toBe('1em');
      // Stroked, not filled: a filled shape would ignore `stroke` entirely and
      // paint itself black on a dark background.
      expect(drawn.getAttribute('fill'), name).toBe('none');
      cleanup();
    }
  });

  itDom('every icon is hidden from the accessibility tree and says nothing of its own', () => {
    // Two claims, and they are **not** equally well proven — which is the point
    // of saying so here rather than in a table somebody reads later.
    //
    // The `textContent` half is a real guard with a reachable fault: a `<title>`
    // inside one of these is the thing that would give a labelled control a
    // second name, and it is what this catches.
    // Proof: `<title>Keyboard</title>` added to `KeyboardIcon`, this failed on
    // `expected 'Keyboard' to be ''`. Watched, 2026-08-29.
    //
    // The `aria-hidden` half is an **attribute assertion, not a behavioural
    // proof**, and `verify.md` records it as such. The negative `tasks.md`
    // asked for — the attribute removed, the control then having two names —
    // was watched **passing**: an `<svg>` with no `<title>` contributes no
    // accessible name at all, so a labelled button keeps exactly the one name
    // its `aria-label` gives it whether the icon is hidden or not. jsdom
    // exposes no role for a bare `<svg>` either (probed: `img`,
    // `graphics-document`, `graphics-object`, `graphics-symbol` and
    // `presentation` all answer zero, hidden or not). The attribute stays
    // because it is what keeps the two claims independent — the day one of
    // these grows a `<title>`, `aria-hidden` is what stops it being read out —
    // and this line is the only oracle there is for it.
    for (const [name, Icon] of icons) {
      const drawn = drawInAControl(Icon);

      expect(drawn.getAttribute('aria-hidden'), name).toBe('true');
      // IE and Edge make an `<svg>` a tab stop without this; every other
      // browser ignores it. There is no oracle for it here either.
      expect(drawn.getAttribute('focusable'), name).toBe('false');
      expect(drawn.textContent, name).toBe('');
      expect(screen.getByRole('button').getAttribute('aria-label'), name).toBe(
        'Keyboard shortcuts',
      );
      cleanup();
    }
  });
});
