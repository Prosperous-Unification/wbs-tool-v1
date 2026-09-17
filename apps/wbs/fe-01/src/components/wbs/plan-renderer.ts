import { useSyncExternalStore } from 'react';

/**
 * Which of the two things that can draw a plan is drawing it.
 *
 * Two renderers of one plan, not two components with two copies of the state:
 * `WbsTable` owns everything either of them needs and swaps only what it
 * renders at the end. `openspec/changes/mobile-cards/design.md` has why the
 * switch sits there and not above it.
 */
export type PlanRenderer = 'cards' | 'table';

/**
 * The width the table stops being the right answer at, in CSS pixels.
 *
 * 768 is the width the table cannot be made to fit rather than a convention
 * borrowed from a framework: a two-step plan's columns add up to about 1106px
 * before anything scrolls (`table-frame.ts`), and every way of closing that gap
 * — smaller type, fewer columns, a horizontal scroll — is a table nobody can
 * read on a phone. Below this the plan is cards.
 */
export const CARDS_BELOW = 768;

/**
 * The height beneath which the table is never the right answer, whatever the
 * width, in CSS pixels.
 *
 * {@link CARDS_BELOW} alone said a **landscape phone is a desktop**: an iPhone
 * 14 turned sideways is 844 CSS px wide, so it cleared the width test and
 * landed on the 1471px table — 689px of horizontal scroll and 243 controls
 * under 44px, on a screen 390px tall. Measured on dev at `9b62ef1`,
 * 2026-08-22.
 *
 * The width boundary is not the fault and does not move: a real tablet at
 * 768×1024 wants the table and gets it. What the rule was missing is that **a
 * landscape phone is told apart from a tablet by its height**, so that is the
 * dimension added, rather than the tempting `Math.min(width, height) < 768` —
 * which would draw cards on a 1366×768 laptop, whose viewport is around 630px
 * once browser chrome is taken off. The short side is not the question; whether
 * the height is a *phone's* is.
 *
 * 500 sits in the gap between the two populations rather than at either edge.
 * The tallest phone in landscape is about 430 (iPhone 14 Pro Max, 932×430); the
 * shortest tablet in landscape is 744 (iPad mini, 1133×744). Anything between
 * is a desktop window dragged unusually short, and a table with two rows
 * visible is worth less there than cards are.
 */
export const TABLE_NEEDS_HEIGHT = 500;

/**
 * Which renderer a viewport this size gets.
 *
 * Pure, and the only place the numbers are compared, because this is where the
 * fault would live — {@link useRendererForViewport} does nothing but feed it a
 * size. The question is the viewport's box and nothing else: not the pointer,
 * not the user agent, not `orientation`, so a short narrow window on a laptop
 * is answered exactly as a phone is, and a phone that reports nothing unusual
 * about itself still gets cards.
 */
export function rendererForViewport(width: number, height: number): PlanRenderer {
  return width < CARDS_BELOW || height < TABLE_NEEDS_HEIGHT ? 'cards' : 'table';
}

/**
 * Tells React when to ask again, which is whenever the window changes size.
 *
 * A rotation, a browser chrome that appears, a desktop window dragged narrow:
 * all of them are one `resize`. Nothing here is debounced — the snapshot below
 * is a string of two values, so a burst of resize events that do not cross the
 * breakpoint produce one unchanged snapshot and no re-render at all.
 *
 * `resize` and not `orientationchange`: the latter is deprecated, is not fired
 * by a desktop window being dragged short, and fires *alongside* a `resize` on
 * the one event it does describe — so subscribing to it would buy a second
 * wake-up for a rotation and nothing at all for the other three ways the height
 * changes.
 */
function subscribeToResize(onResize: () => void): () => void {
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
  };
}

/**
 * The renderer this viewport asks for, following it while the page is open.
 *
 * `window.innerWidth` rather than `matchMedia`, which is the idiomatic answer
 * and is not available: **jsdom 24 ships no `window.matchMedia` at all** —
 * probed on 2026-08-09, not assumed — so a hook built on it would throw in
 * every one of this app's tests, and the usual repair is a stub that always
 * answers `false`, which is a breakpoint test asserting the stub.
 *
 * `useSyncExternalStore` rather than a `useState` an effect writes after the
 * first paint: on a phone that first paint is the whole table laid out at
 * 1106px and thrown away. The snapshot is a primitive, so React compares it by
 * value and a resize that does not cross the breakpoint re-renders nothing.
 *
 * `innerHeight` beside `innerWidth` for the same reason as the width — it is
 * the *viewport's* height, after the browser's own chrome, which is the number
 * the plan is drawn into. `screen.height` would answer with the device and call
 * a landscape phone 844 tall.
 */
export function useRendererForViewport(): PlanRenderer {
  return useSyncExternalStore(subscribeToResize, () =>
    rendererForViewport(window.innerWidth, window.innerHeight),
  );
}
