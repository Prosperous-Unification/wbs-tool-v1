/**
 * A calendar marker's colour, and the two WCAG bars it clears.
 *
 * A marker is two things at once, so it answers to two thresholds: **3:1** for
 * the chip fill and the body rule against whatever the chart has already
 * painted (1.4.11, the non-text bar), and **4.5:1** for the chip's label
 * against its own fill (1.4.3). `design.md` §6 of the `gantt-calendar-markers`
 * change names both bars and both sets of backdrops and deliberately leaves the
 * eight hex values here, because they are a *measured* result: writing eight
 * unmeasured hexes into a design document asserts an accessibility outcome
 * nobody computed.
 *
 * **The body rule is not drawn on `--background`.** It sits at slot 7 of the
 * paint order, over four area fills the base background does not account for —
 * the weekend column, the zebra band, the pointed row's light and today's
 * column. Three are translucent tints; the pointed row's light is an *opaque*
 * `color-mix`, so it replaces what is beneath it rather than compositing over
 * it. That is what makes the set **10 per theme, 20 in all** rather than two:
 * eight composites without the pointed light (weekend × zebra × today, each
 * optional) and two with it (which erase the weekend and zebra beneath and take
 * only the optional today tint).
 *
 * `MARKER_BACKDROPS` is the whole of that set, resolved, and it is the single
 * table both the palette measurement and `validateCustomColor` read — "the same
 * 20 backdrops" is a sentence unless one table is the only place they come
 * from.
 */

/** Three numbers, whichever space they are in. */
export type Triple = readonly [number, number, number];

/** An 8-bit sRGB triple, the space every bar in here is measured in. */
export type Rgb = Triple;

/** An oklab cartesian triple — `L`, `a`, `b`. */
export type Oklab = Triple;

/** Black or white. The label ink is a choice between exactly these two. */
export type LabelInk = '#000000' | '#ffffff';

/** One palette entry: the chip fill, and the ink recorded as clearing 4.5:1 over it. */
export interface PaletteEntry {
  /** A name the ratio table and `verify.md` can be read by. Not shown to a user. */
  readonly name: string;
  /** The chip fill and the body rule's stroke. Lowercase `#rrggbb`. */
  readonly fill: string;
  /** The label colour recorded for this fill — see `labelInk`, which must agree. */
  readonly label: LabelInk;
}

/** One resolved surface the 3:1 bar is measured against. */
export interface MarkerBackdrop {
  /** `<theme>:<composite>`, the name a refusal quotes so the user can find the fill. */
  readonly name: string;
  /** The composited result, lowercase `#rrggbb`. */
  readonly color: string;
}

// --- colour arithmetic -----------------------------------------------------

/**
 * The one spelling of "a hex triple" in this codebase.
 *
 * Named once and read by both {@link parseHex} and {@link isHexTriple} on
 * purpose: an API that refuses a shape `parseHex` would have thrown on, or
 * accepts one it would not, is two rules wearing one name. Not exported —
 * `isHexTriple` is the question callers have.
 */
const HEX_TRIPLE = /^#([0-9a-fA-F]{6})$/;

/**
 * Is this a well-formed `#rrggbb`?
 *
 * The **precondition** {@link validateCustomColor} states and does not check:
 * that function throws through `parseHex` on a malformed colour, because a
 * contrast verdict about a typo would be an answer to a question nobody asked.
 * A boundary that takes colours from a client asks this first, answers
 * `malformed`, and only then asks about contrast.
 */
export function isHexTriple(hex: string): boolean {
  return HEX_TRIPLE.test(hex);
}

/**
 * `#rrggbb` to an sRGB triple. Throws on anything else.
 *
 * Six digits only, and the three-digit form is deliberately not accepted: every
 * colour in here is written six-digit, and a validator that silently widened
 * `#f00` would be accepting a shape no stored marker uses.
 */
export function parseHex(hex: string): Rgb {
  const found = HEX_TRIPLE.exec(hex);
  if (!found) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(found[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** An sRGB triple back to lowercase `#rrggbb`. */
export function formatHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Oklch as CSS writes it, to the oklab cartesian triple the mixing happens in. */
export function oklchToOklab(l: number, c: number, h: number): Oklab {
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

/**
 * `color-mix(in oklab, <a> <p>%, <b>)` — a straight linear mix of the two
 * oklab triples, which is what the function means over two opaque inputs.
 */
export function mixOklab(a: Oklab, b: Oklab, p: number): Oklab {
  return [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)];
}

/** An oklab triple to 8-bit sRGB, clipped to the cube. */
export function oklabToRgb([l, a, b]: Oklab): Rgb {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const encode = (v: number) => {
    const e = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(e * 255)));
  };
  return [encode(linear[0]), encode(linear[1]), encode(linear[2])];
}

/** `oklch(l c h)` straight to 8-bit sRGB. */
export function oklchToRgb(l: number, c: number, h: number): Rgb {
  return oklabToRgb(oklchToOklab(l, c, h));
}

/** Source-over: `alpha` of `fg` painted on an opaque `bg`. */
export function compositeOver(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1 to 21, order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- the measured tables ---------------------------------------------------

/**
 * The 20 surfaces the 3:1 bar is measured against — 10 per theme.
 *
 * Derived from `apps/fe-01/src/styles.css` and the four fill classes in
 * `gantt-panel.tsx`, and recorded here as resolved literals rather than
 * recomputed at import time. `marker-color.test.ts` re-derives the whole set
 * from `styles.css` and deep-equals it against this table, so a theme change
 * that darkened a band breaks the test rather than the chart, and a wrong
 * literal here cannot agree with itself.
 */
export const MARKER_BACKDROPS: readonly MarkerBackdrop[] = [
  { name: 'light:base', color: '#ffffff' },
  { name: 'light:base+today', color: '#dbf2fc' },
  { name: 'light:base+zebra', color: '#f9fbfd' },
  { name: 'light:base+zebra+today', color: '#d6eefa' },
  { name: 'light:base+weekend', color: '#eff1f4' },
  { name: 'light:base+weekend+today', color: '#cde6f2' },
  { name: 'light:base+weekend+zebra', color: '#f0f3f6' },
  { name: 'light:base+weekend+zebra+today', color: '#cee7f4' },
  { name: 'light:pointed', color: '#e8ecf1' },
  { name: 'light:pointed+today', color: '#c7e1f0' },
  { name: 'dark:base', color: '#020618' },
  { name: 'dark:base+today', color: '#041e37' },
  { name: 'dark:base+zebra', color: '#0d1427' },
  { name: 'dark:base+zebra+today', color: '#0d2a44' },
  { name: 'dark:base+weekend', color: '#101628' },
  { name: 'dark:base+weekend+today', color: '#102b45' },
  { name: 'dark:base+weekend+zebra', color: '#151e30' },
  { name: 'dark:base+weekend+zebra+today', color: '#14324c' },
  { name: 'dark:pointed', color: '#10182b' },
  { name: 'dark:pointed+today', color: '#102d48' },
];

/** The non-text bar (WCAG 1.4.11) the fill and the body rule clear on every backdrop. */
export const MARKER_FILL_BAR = 3;

/** The text bar (WCAG 1.4.3) the chip's label clears against its own fill. */
export const MARKER_LABEL_BAR = 4.5;

/**
 * Eight entries, and the count is load-bearing: a test can iterate eight, it
 * cannot iterate "a fixed accessible palette".
 *
 * **Every entry sits at essentially one luminance, and that is forced rather
 * than chosen.** Clearing 3:1 against both the darkest light backdrop
 * (`light:pointed+today`, luminance 0.7242) and the lightest dark one
 * (`dark:base+weekend+zebra+today`, 0.02908) confines the fill to
 * `0.1872 ≤ L ≤ 0.2081`; the two constraints balance at `L = 0.19744`, where
 * the best attainable worst-case ratio over the whole set is **3.129**. So the
 * palette is at the measurement's ceiling, no palette can do better against
 * this backdrop set, and the entries are distinguished by hue and chroma rather
 * than by lightness. All eight therefore take **black** ink, which is why
 * `labelInk`'s discrimination is proved at the ends of the sRGB cube and not by
 * this table (see `marker-color.test.ts`).
 *
 * All 160 measured ratios are in the change's `verify.md`.
 */
export const PALETTE: readonly PaletteEntry[] = [
  { name: 'crimson', fill: '#f70100', label: '#000000' },
  { name: 'amber', fill: '#ab6e00', label: '#000000' },
  { name: 'olive', fill: '#3e8c03', label: '#000000' },
  { name: 'forest', fill: '#038e3e', label: '#000000' },
  { name: 'teal', fill: '#0386a5', label: '#000000' },
  { name: 'azure', fill: '#5d6afe', label: '#000000' },
  { name: 'violet', fill: '#bb31fc', label: '#000000' },
  { name: 'magenta', fill: '#eb0193', label: '#000000' },
];

// --- the two functions -----------------------------------------------------

/**
 * 32-bit FNV-1a over the id's UTF-8 bytes.
 *
 * Named rather than left as "some stable hash": two implementations of "a
 * deterministic hash" produce two different correct-looking tables, and the
 * pinned vectors in the test are only reproducible against a named one.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The colour a marker gets when the user did not pick one.
 *
 * **From the id, and from nothing else.** Order- or count-derived colour
 * recolours every earlier marker when one is deleted, which is a visible bug
 * with no error message; keying on the name breaks under a rename; keying on
 * the date gives two markers on one day the same colour, which is the identity
 * a stacked band exists to distinguish.
 */
export function automaticColor(markerId: string): string {
  return PALETTE[fnv1a32(markerId) % PALETTE.length].fill;
}

/**
 * Black or white, whichever contrasts more with the chip fill.
 *
 * **Total, with no refusal arm.** The two contrasts multiply to exactly 21 for
 * every fill luminance, so the better of them is never below `sqrt(21) ≈ 4.583`
 * and the 4.5:1 label bar cannot be failed. They are equal at
 * `L = sqrt(0.0525) - 0.05 ≈ 0.17913` and one is strictly larger everywhere
 * else, so that crossover is the only input at which a chooser written as a
 * strict inequality could fall through both arms — hence `>=`, and hence the
 * union return type with no third member.
 */
export function labelInk(fill: string): LabelInk {
  const rgb = parseHex(fill);
  const onBlack = contrastRatio(rgb, [0, 0, 0]);
  const onWhite = contrastRatio(rgb, [255, 255, 255]);
  return onBlack >= onWhite ? '#000000' : '#ffffff';
}

/** One backdrop a candidate colour failed the 3:1 bar over, and by how much. */
export interface BackdropFailure {
  /** The backdrop's name, so a refusal can say which fill rather than which theme. */
  readonly backdrop: string;
  /** The measured ratio, rounded to three places — what the message quotes. */
  readonly ratio: number;
}

/** What `validateCustomColor` answers. `ok` is `failures.length === 0`. */
export interface CustomColorVerdict {
  readonly ok: boolean;
  /** Every failing backdrop, in `MARKER_BACKDROPS` order. Empty when `ok`. */
  readonly failures: readonly BackdropFailure[];
  /** The refusal a user reads, naming the first failing backdrop and the bar. `null` when `ok`. */
  readonly message: string | null;
}

/**
 * A user-chosen colour against the 3:1 bar, over **every** backdrop.
 *
 * **The refusal names the backdrop, not the theme.** A colour can clear bare
 * dark and fail dark-over-weekend, so "too dark for the dark theme" would send
 * the user hunting a fill it never named. `message` quotes the first failure in
 * `MARKER_BACKDROPS` order and `failures` carries all of them.
 *
 * **It reads `MARKER_BACKDROPS` and measures every entry**, which is the only
 * thing that makes "the same 20 backdrops the palette is measured against" true
 * rather than asserted: a validator that imported the table and then measured
 * two of it would pass a complete table and both of the obvious colour cases.
 *
 * **Shape is a precondition, not a verdict.** `hex` must already be a
 * well-formed `#rrggbb`; `parseHex` throws otherwise. A malformed colour is
 * refused upstream by the API schema and by the composer's input, and folding
 * the two refusals together would let a contrast message answer a typo.
 *
 * **There is no label-contrast arm.** The 4.5:1 bar cannot be failed — the ink
 * is black or white, whichever contrasts more, and the better of the two is
 * never below `sqrt(21)` — so it is a property of `labelInk` and not something
 * a colour can trip.
 */
export function validateCustomColor(hex: string): CustomColorVerdict {
  const candidate = parseHex(hex);
  const failures: BackdropFailure[] = [];
  for (const backdrop of MARKER_BACKDROPS) {
    const ratio = contrastRatio(candidate, parseHex(backdrop.color));
    if (ratio < MARKER_FILL_BAR) {
      failures.push({ backdrop: backdrop.name, ratio: Math.round(ratio * 1000) / 1000 });
    }
  }
  if (failures.length === 0) return { ok: true, failures: [], message: null };
  const [first] = failures;
  return {
    ok: false,
    failures,
    message:
      `${hex} is ${String(first.ratio)}:1 against ${first.backdrop}, below the ` +
      `${String(MARKER_FILL_BAR)}:1 the marker rule needs there`,
  };
}
