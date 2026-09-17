import { type RefCallback, useCallback, useEffect, useState } from 'react';

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
 * The callback ref makes the mounted node an effect dependency. Some controls,
 * including Export, are absent until their boundary read succeeds; a one-shot
 * effect that reads `ref.current` can run before that `<details>` exists and
 * never install its listener.
 */
export function useClosedByPointerOutside(): RefCallback<HTMLDetailsElement> {
  const [panel, setPanel] = useState<HTMLDetailsElement | null>(null);
  const rememberPanel = useCallback((node: HTMLDetailsElement | null): void => {
    setPanel(node);
  }, []);

  useEffect(() => {
    if (panel === null) return undefined;

    const closeIfOutside = (event: PointerEvent): void => {
      // Nothing to close, and nothing to read the target for.
      if (!panel.open) return;
      const { target } = event;
      if (target instanceof Node && panel.contains(target)) return;
      panel.open = false;
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
    };
  }, [panel]);

  return rememberPanel;
}
