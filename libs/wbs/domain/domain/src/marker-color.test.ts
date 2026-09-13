import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import {
  automaticColor,
  compositeOver,
  contrastRatio,
  fnv1a32,
  formatHex,
  labelInk,
  MARKER_BACKDROPS,
  MARKER_FILL_BAR,
  MARKER_LABEL_BAR,
  mixOklab,
  oklabToRgb,
  oklchToOklab,
  oklchToRgb,
  PALETTE,
  parseHex,
  relativeLuminance,
  type Rgb,
  validateCustomColor,
} from './marker-color';

/**
 * The theme file the backdrops come from. Read rather than transcribed: three
 * of the four body fills are custom properties in it, so a theme change that
 * darkened a band has to break this test rather than the chart.
 */
const STYLES = new URL('../../../apps/fe-01/src/styles.css', import.meta.url);

/**
 * `sky-500` is the fourth fill and it is **not** in `styles.css` — it is a
 * built-in Tailwind palette colour, used directly by `fill-sky-500/15`
 * (`gantt-panel.tsx:2955`) and appearing zero times in the theme file. So it is
 * pinned here as a literal and recorded in `verify.md`, and the other three are
 * read.
 */
const SKY_500 = '#0ea5e9';

/** The three tint alphas, from the four `fill-*` classes in `gantt-panel.tsx`. */
const WEEKEND_ALPHA = 0.1; // fill-muted-foreground/10, :2888
const ZEBRA_ALPHA = 0.4; // fill-muted/40, :2908
const TODAY_ALPHA = 0.15; // fill-sky-500/15, :2955

/** The text of one top-level block of `styles.css`, marker to its closing brace. */
function block(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`styles.css has no ${opener} block`);
  const end = css.indexOf('\n}', at);
  if (end < 0) throw new Error(`${opener} block is unterminated`);
  return css.slice(at, end);
}

/** One `--name: oklch(l c h);` declaration, as the oklch triple CSS wrote. */
function oklchVar(section: string, name: string): [number, number, number] {
  const found = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(
    section,
  );
  if (!found) throw new Error(`no --${name} in that block`);
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/**
 * The whole backdrop set, derived rather than pasted.
 *
 * `expect(perTheme).toHaveLength(10)` below is what makes a dropped fill fail
 * on a count instead of silently shrinking the bar the palette is measured
 * against.
 */
function deriveBackdrops(): { name: string; color: string }[] {
  const css = readFileSync(STYLES, 'utf8');
  const light = block(css, ':root {');
  const dark = block(css, '.dark {');

  // --grid-dep-lit is the fourth fill and the one that is not a tint: an opaque
  // color-mix over two opaque inputs. Its dose is read too, so moving the 20%
  // moves this test.
  const dose = /--grid-dep-lit:\s*color-mix\(in oklab,\s*var\(--ring\)\s*(\d+)%/.exec(css);
  if (!dose) throw new Error('styles.css no longer defines --grid-dep-lit as a ring mix');
  const ringShare = Number(dose[1]) / 100;

  const rows: { name: string; color: string }[] = [];
  for (const [theme, section] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    const bg = oklchVar(section, 'background');
    const base = oklchToRgb(...bg);
    const mutedForeground = oklchToRgb(...oklchVar(section, 'muted-foreground'));
    const muted = oklchToRgb(...oklchVar(section, 'muted'));
    const pointed = oklabToRgb(
      mixOklab(oklchToOklab(...oklchVar(section, 'ring')), oklchToOklab(...bg), ringShare),
    );
    const sky = parseHex(SKY_500);

    const perTheme: { name: string; color: string }[] = [];
    // Paint order is weekend, zebra, pointed, today. Without the pointed row's
    // light the three tints are independently optional: 2 x 2 x 2 = 8.
    for (const weekend of [false, true]) {
      for (const zebra of [false, true]) {
        for (const today of [false, true]) {
          let color: Rgb = base;
          const parts = ['base'];
          if (weekend) {
            color = compositeOver(mutedForeground, WEEKEND_ALPHA, color);
            parts.push('weekend');
          }
          if (zebra) {
            color = compositeOver(muted, ZEBRA_ALPHA, color);
            parts.push('zebra');
          }
          if (today) {
            color = compositeOver(sky, TODAY_ALPHA, color);
            parts.push('today');
          }
          perTheme.push({ name: `${theme}:${parts.join('+')}`, color: formatHex(color) });
        }
      }
    }
    // With it, it erases the weekend and zebra beneath and takes only the
    // optional today tint on top: 2 more.
    for (const today of [false, true]) {
      const color = today ? compositeOver(sky, TODAY_ALPHA, pointed) : pointed;
      perTheme.push({
        name: `${theme}:pointed${today ? '+today' : ''}`,
        color: formatHex(color),
      });
    }

    expect(perTheme).toHaveLength(10);
    rows.push(...perTheme);
  }
  return rows;
}

/** Sorted by name, so a deep-equal is about membership rather than ordering. */
function byName<T extends { name: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

describe('the backdrop set', () => {
  it('is the twenty surfaces §6 derives from styles.css, and MARKER_BACKDROPS is that set', () => {
    // The table case, and it is what makes "the same 20 backdrops" executable
    // rather than a sentence maintained by prose: `validateCustomColor` and the
    // palette measurement both read MARKER_BACKDROPS, and this asserts that
    // table IS the derived set — 20 entries, 10 per theme, each naming its
    // composite and carrying its resolved colour.
    const derived = deriveBackdrops();
    expect(derived).toHaveLength(20);
    expect(byName(MARKER_BACKDROPS)).toEqual(byName(derived));
  });

  it('carries the three surfaces the composites are built from, resolved', () => {
    // Not decoration: if `oklchToRgb` were wrong the deep-equal above would
    // fail without saying where, and these three are the values every row is
    // built out of. They are Tailwind's slate ramp, which is the independent
    // check — `styles.css` writes them in oklch and never in hex.
    const css = readFileSync(STYLES, 'utf8');
    expect(formatHex(oklchToRgb(...oklchVar(block(css, ':root {'), 'background')))).toBe('#ffffff');
    expect(formatHex(oklchToRgb(...oklchVar(block(css, '.dark {'), 'background')))).toBe('#020618');
    expect(formatHex(oklchToRgb(...oklchVar(block(css, '.dark {'), 'muted')))).toBe('#1d293d');
  });
});

describe('the palette', () => {
  it('is eight entries', () => {
    // First, and before the ratio loop: without a length assertion that loop
    // passes over an empty or one-entry palette, and `automaticColor`'s
    // `PALETTE.length` divisor would then make a constant function
    // indistinguishable from a correct one.
    expect(PALETTE).toHaveLength(8);
    expect(new Set(PALETTE.map((e) => e.fill)).size).toBe(8);
  });

  it('clears 3:1 on every one of the twenty backdrops, and 4.5:1 for its own label', () => {
    for (const entry of PALETTE) {
      const fill = parseHex(entry.fill);
      for (const backdrop of MARKER_BACKDROPS) {
        const ratio = contrastRatio(fill, parseHex(backdrop.color));
        expect({ entry: entry.name, backdrop: backdrop.name, ratio: ratio >= MARKER_FILL_BAR }) //
          .toEqual({ entry: entry.name, backdrop: backdrop.name, ratio: true });
      }
      expect(contrastRatio(parseHex(entry.label), fill)).toBeGreaterThanOrEqual(MARKER_LABEL_BAR);
    }
  });
});

describe('automaticColor', () => {
  /**
   * Four ids with the exact hex each must return, under 32-bit FNV-1a mod 8
   * against the landed palette. Recorded, not recomputed: a vector the code
   * under test derives at run time is the code agreeing with itself.
   *
   * `Proof:` computed once from `PALETTE` and `fnv1a32` and written down here
   * and in `verify.md`. Four distinct colours, so a constant implementation
   * fails on the first row rather than on the fourth.
   */
  const VECTORS: readonly [string, number, string][] = [
    ['0f5a1c2e-7b64-4d3a-9e18-2c5f8a41b7d0', 3786943175, '#eb0193'],
    ['a41b8e62-9d07-4c5b-b3f8-71e2d04a9c6e', 3195973148, '#0386a5'],
    ['d7e30f45-6a8b-49c1-95d2-08f3b7c61ae9', 367341714, '#3e8c03'],
    ['88c1e0f7-42ab-4d59-9376-1be5c80f2a34', 2076945931, '#038e3e'],
  ];

  it('sends each pinned id to its pinned colour', () => {
    for (const [id, hash, hex] of VECTORS) {
      expect({ id, hash: fnv1a32(id), hex: automaticColor(id) }).toEqual({ id, hash, hex });
    }
    expect(new Set(VECTORS.map(([, , hex]) => hex)).size).toBe(4);
  });

  it('does not move a marker’s colour when an earlier marker is deleted', () => {
    // The fault this is here for is a module-level counter — order-derived
    // exactly as the requirement forbids, and compilable because it changes no
    // signature. Deleting the first of three has to leave the other two alone.
    const [one, two, three] = VECTORS.slice(0, 3).map(([id]) => id);
    const before = [one, two, three].map(automaticColor);
    const after = [two, three].map(automaticColor);
    expect(after).toEqual(before.slice(1));
  });
});

describe('labelInk', () => {
  it('agrees with every recorded label, and picks the higher-contrast of the two', () => {
    // One assertion binding the two sources of truth the palette table leaves
    // unrelated: `PaletteEntry.label` is a literal checked against a literal
    // above, and this is the only place the ink is *chosen*.
    for (const entry of PALETTE) {
      const fill = parseHex(entry.fill);
      const chosen = labelInk(entry.fill);
      const onBlack = contrastRatio(fill, [0, 0, 0]);
      const onWhite = contrastRatio(fill, [255, 255, 255]);
      expect({ name: entry.name, ink: chosen }).toEqual({ name: entry.name, ink: entry.label });
      expect(contrastRatio(fill, parseHex(chosen))).toBe(Math.max(onBlack, onWhite));
    }
  });

  it('discriminates at both ends of the sRGB cube', () => {
    // The palette cannot prove this. Every entry sits at L ≈ 0.1974 — forced by
    // the 20-backdrop window, not chosen — which is above the crossover, so all
    // eight take black and a chooser hard-coded to black agrees with the whole
    // table. The cube's ends are what separate a chooser from a constant.
    expect(labelInk('#000000')).toBe('#ffffff');
    expect(labelInk('#ffffff')).toBe('#000000');
  });

  it('is total at the crossover, where the two contrasts are equal', () => {
    // The two ratios multiply to exactly 21 for every fill luminance, so they
    // are equal at L = sqrt(0.0525) - 0.05 and one is strictly larger
    // everywhere else. That equality is the only input at which a chooser
    // written as a strict inequality can fall through both arms — so this is a
    // totality check, not the discrimination, and either answer passes.
    //
    // **The crossover is not representable as a fill.** `labelInk` takes
    // `#rrggbb`, so the tightest approach to it is one 8-bit step: #757575 sits
    // 0.0012 below and #767676 above, and the plan's "within 1e-6" could not be
    // written at this resolution. Bracketing is the honest form of the same
    // check — both neighbours are asserted, so whichever side a strict
    // inequality falls through is covered.
    const crossover = Math.sqrt(0.0525) - 0.05;
    expect(relativeLuminance(parseHex('#757575'))).toBeLessThan(crossover);
    expect(relativeLuminance(parseHex('#767676'))).toBeGreaterThan(crossover);
    for (const fill of ['#757575', '#767676']) {
      const ink = labelInk(fill);
      expect(['#000000', '#ffffff']).toContain(ink);
      expect(contrastRatio(parseHex(fill), parseHex(ink))).toBeGreaterThanOrEqual(MARKER_LABEL_BAR);
    }
  });
});

describe('validateCustomColor', () => {
  it('accepts every palette entry', () => {
    for (const entry of PALETTE) {
      expect({ name: entry.name, ...validateCustomColor(entry.fill) }).toEqual({
        name: entry.name,
        ok: true,
        failures: [],
        message: null,
      });
    }
  });

  it('refuses a colour that clears light and fails dark, naming the dark base', () => {
    // #7a3400 is luminance 0.0659 — it clears every light backdrop comfortably
    // and fails all ten dark ones. The first failure in table order is the bare
    // dark base, which is the one the message has to name.
    const verdict = validateCustomColor('#7a3400');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toEqual({ backdrop: 'dark:base', ratio: 2.226 });
    expect(verdict.message).toContain('dark:base');
    expect(verdict.message).toContain('3:1');
  });

  it('refuses a colour that clears both bases and fails a composite, naming the composite', () => {
    // #0066ff clears light:base AND dark:base, and clears three of the six
    // earlier dark composites too — it first fails at weekend+today. So a
    // refusal that named only a theme would be pointing at a surface this
    // colour is perfectly legible on.
    const verdict = validateCustomColor('#0066ff');
    expect(verdict.ok).toBe(false);
    expect(validateCustomColor('#0066ff').failures.map((f) => f.backdrop)).toEqual([
      'dark:base+weekend+today',
      'dark:base+weekend+zebra+today',
      'dark:pointed+today',
    ]);
    expect(verdict.message).toContain('dark:base+weekend+today');
  });

  it('measures all twenty, not the two the cases above name', () => {
    // The observer for the loop rather than for the table. The deep-equality
    // case up in "the backdrop set" proves MARKER_BACKDROPS holds 20 entries,
    // and a validator that imported that table and then measured only the two
    // surfaces the two cases above exercise would pass every one of them.
    //
    // #ff0000 fails exactly one backdrop out of twenty — the light theme's
    // pointed-row light under the today tint, which is the only surface the
    // pointed light contributes that neither case above touches, and the one a
    // validator that composites the three tints over --background and stops
    // there never builds at all.
    const verdict = validateCustomColor('#ff0000');
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual([{ backdrop: 'light:pointed+today', ratio: 2.943 }]);
    expect(verdict.message).toContain('light:pointed+today');
  });

  it('treats shape as a precondition rather than a verdict', () => {
    // A malformed hex is refused upstream, by the API schema and by the
    // composer's own input. Folding the two refusals together would let a
    // contrast message answer a typo.
    expect(() => validateCustomColor('#f00')).toThrow('not a hex colour');
    expect(() => validateCustomColor('red')).toThrow('not a hex colour');
  });
});
