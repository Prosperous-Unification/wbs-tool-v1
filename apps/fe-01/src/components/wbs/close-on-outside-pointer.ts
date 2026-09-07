import { type RefObject, useEffect, useRef } from 'react';

/**
 * Closes an open `<details>` when a pointer goes down anywhere outside it.
 *
 * The toolbar's four panels — Filters, Views, Columns and Export — are
 * `<details>` elements rather than positioned popovers, for the reason
 * {@link FilterFacets} gives: no measurement, no portal, and the disclosure
 * state is the element's own. What that shape does not give is a menu's manners.
 * A native `<details>` closes on its summary and on nothing else, so an open
 * panel stayed open over the plan while the reader went back to the table —
 * reported by Dany on 2026-08-31: "allow to collapse Filters, Views, Columns
 * pop-ups by clicking somewhere outside the space".
 *
 * `pointerdown` and not `click`, in the **capture** phase: a menu that closes on
 * the way down is what every other menu on this page does, and the reader's
 * click then lands on whatever they aimed at rather than being spent shutting
 * the panel. Capture so this runs before the grid's own handlers, which stop
 * some events on their way up.
 *
 * A pointer inside the panel is left alone — every control in there is a thing
 * to tick, and `node.contains` covers the summary too, so clicking the summary
 * still toggles rather than being closed and reopened in one gesture.
 *
 * Native `<select>` popups (the Export panel's Mermaid lanes picker) are drawn
 * by the platform, not the document, so choosing from one fires no `pointerdown`
 * here and cannot close the panel underneath it.
 *
 * `| null` in the return type is React 19's own: `useRef<T>(null)` now answers
 * `RefObject<T | null>`, which is what a `ref` prop takes.
 */
export function useClosedByPointerOutside(): RefObject<HTMLDetailsElement | null> {
  const panel = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const node = panel.current;
    if (node === null) return undefined;

    const closeIfOutside = (event: PointerEvent): void => {
      // Nothing to close, and nothing to read the target for.
      if (!node.open) return;
      const { target } = event;
      if (target instanceof Node && node.contains(target)) return;
      node.open = false;
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
    };
  }, []);

  return panel;
}
