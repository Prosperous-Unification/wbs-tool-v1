import { type Locator } from '@playwright/test';

/** One measured ink: its three OKLCh components, what it stands on, and the ratio between. */
export interface MeasuredInk {
  lightness: number;
  chroma: number;
  hue: number;
  /** The composited ground the ink is painted over, in the same OKLCh terms. */
  surface: { lightness: number; chroma: number; hue: number };
  contrast: number;
}

/**
 * Above this, a colour carries a hue somebody can name.
 *
 * `priority-ramp.spec.ts`' figure, which is where it was first needed: the
 * neutral rung of the priority ramp is `oklch(… 0.02 …)` and the two cool rungs
 * are 0.06 and 0.12, so 0.03 separates "this is grey" from "this is a colour".
 * The palette's own `--muted-foreground` sits at 0.046 and 0.04, which is above
 * it — a token that is deliberately a *cool* grey rather than a neutral one — so
 * a claim about a **grey** ink is made against
 * {@link NAMELESS_CHROMA_FOR_GREY_INK} instead.
 */
export const NEUTRAL_CHROMA = 0.03;

/**
 * Above this, an ink meant to be grey is carrying a colour.
 *
 * The palette's greys are cool by design — `--muted-foreground` is
 * `oklch(0.554 0.046 257)` in the light palette and `oklch(0.704 0.04 257)` in
 * the dark one — so 0.03 is under the greys themselves and cannot be the ceiling
 * for one. 0.09 is set between the palette's grey (0.046) and the ink a claim
 * about greyness is actually about: `--destructive` at 0.245 and 0.191, and the
 * ~0.03–0.06 a 12% tint of it lands on. Wide enough that an 8-bit round trip
 * cannot cross it, narrow enough that the red it exists to refuse is nowhere
 * near it.
 */
export const NAMELESS_CHROMA_FOR_GREY_INK = 0.09;

/**
 * The colour a node's text is actually painted, in OKLCh, with its ground and
 * its contrast.
 *
 * Rasterised through a 2D canvas and converted back rather than read as text:
 * Chromium is free to serialise `color` as `oklch(…)`, `color(srgb …)` or `rgb(…)`
 * depending on the value and the version, and an assertion about a **margin**
 * cannot be made against any of those strings. Going through the canvas measures
 * what was painted, which is the thing under test, and the magenta sentinel turns
 * "this engine will not parse that" into a failure instead of a stale read.
 *
 * The surface is composited up the ancestors exactly as `dark-mode.spec.ts` does
 * it: almost nothing in this app paints its own background, so a ratio against
 * one node's `rgba(0, 0, 0, 0)` would be a number about nothing. It is returned
 * as well as spent on the contrast, because a tag whose *ground* carries the hue
 * is still a red tag however grey its lettering is.
 *
 * The sRGB → OKLab matrices are Ottosson's, which is what CSS Color 4 defines
 * `oklch()` against — so a value that survives the round trip comes back as the
 * numbers written in `priority-band-style.ts`, give or take 8-bit quantisation.
 *
 * @param locator The node whose text is measured. Must resolve to exactly one.
 * @returns Its ink, its composited ground, and the WCAG ratio between them.
 * @throws If the page has no 2D context, or Chromium refuses a colour the
 * stylesheet named — either is a measurement that did not happen, and a
 * measurement that did not happen must never read as a pass.
 */
export function measureInk(locator: Locator): Promise<MeasuredInk> {
  return locator.evaluate((node) => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx === null) throw new Error('no 2d context to rasterise a colour in');
    const rgbaOf = (colour: string): [number, number, number, number] => {
      const sentinel = '#ff00ff';
      ctx.fillStyle = sentinel;
      ctx.fillStyle = colour;
      if (ctx.fillStyle === sentinel) throw new Error(`this engine will not parse ${colour}`);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const painted = ctx.getImageData(0, 0, 1, 1).data;
      return [painted[0], painted[1], painted[2], painted[3] / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const linear = (raw: number): number => {
      const unit = raw / 255;
      return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
    };
    const luminance = (colour: [number, number, number]): number =>
      0.2126 * linear(colour[0]) + 0.7152 * linear(colour[1]) + 0.0722 * linear(colour[2]);
    const oklchOf = (
      colour: [number, number, number],
    ): { lightness: number; chroma: number; hue: number } => {
      const [r, g, b] = [linear(colour[0]), linear(colour[1]), linear(colour[2])];
      const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      const lightness = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
      const green = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
      const blue = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
      const hue = ((Math.atan2(blue, green) * 180) / Math.PI + 360) % 360;
      return { lightness, chroma: Math.hypot(green, blue), hue };
    };

    const stacked: [number, number, number, number][] = [];
    let ancestor: Element | null = node;
    while (ancestor !== null) {
      const painted = rgbaOf(getComputedStyle(ancestor).backgroundColor);
      if (painted[3] > 0) stacked.push(painted);
      if (painted[3] === 1) break;
      ancestor = ancestor.parentElement;
    }
    // White, because that is what a browser paints a document nothing painted.
    let surface: [number, number, number] = [255, 255, 255];
    for (const layer of stacked.reverse()) surface = over(layer, surface);

    const ink = over(rgbaOf(getComputedStyle(node).color), surface);
    const [brighter, dimmer] = [luminance(ink), luminance(surface)].sort((a, b) => b - a);
    return {
      ...oklchOf(ink),
      surface: oklchOf(surface),
      contrast: (brighter + 0.05) / (dimmer + 0.05),
    };
  });
}
