import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HoverPreview } from './hover-preview';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

/** The preview over one work item, and the element it rendered into. */
function previewOf(name: string, notes: string): HTMLElement {
  render(<HoverPreview name={name} notes={notes} number="010" />);
  return screen.getByRole('tooltip');
}

describe('the hover preview reads as one document', () => {
  itDom('renders the name as a level-one heading over the notes’ markdown', () => {
    const preview = previewOf('Strip the old wiring', '## Risks\n\n- the fuse box is *old*');

    expect(preview.querySelector('h1')?.textContent).toBe('Strip the old wiring');
    // The notes still render as markdown under it, at their own level: a
    // preview whose name heading swallowed the notes would pass the line
    // above and fail here.
    expect(preview.querySelector('h2')?.textContent).toBe('Risks');
    expect(preview.querySelector('li em')?.textContent).toBe('old');
  });

  itDom('the heading is not made by the parser', () => {
    // The heading is an `<h1>` this component writes and the emphasis inside it
    // is content the parser made; the two never meet as a string. The rejected
    // implementation is `<Markdown>{`# ${name}`}</Markdown>`, and this is the
    // test that can see it.
    //
    // The punctuation matters and is the whole reason this case is written
    // twice. Proof, the composition put back — the body made
    // `<Markdown>{`# ${name}\n\n${notes}`}</Markdown>` — with the name
    // `# not a heading <script>`, and it **passed**: `# # x` is a heading whose
    // content is the literal `# x`, so the parser handed back the exact string
    // the assertion was making (`AGENTS.md`, R5, `N name-title-body`). The name
    // carries a `#` *and* an `*emphasis*` now, and the same composition was
    // watched failing on
    //   - Expected: `# not a heading <script>alert(1)</script> and *not* emphasis`
    //   - Received: `# not a heading <script>alert(1)</script> and not emphasis`
    // — the parser reaching into a name and eating its asterisks, which the
    // `#` alone could never show. Watched, 2026-08-29.
    const typed = '# not a heading <script>alert(1)</script> and *not* emphasis';
    const preview = previewOf(typed, 'and the note is *rendered*');

    const heading = preview.querySelector('h1');
    expect(heading?.textContent).toBe(typed);
    // No element the parser made out of the name: the `#` opened no heading,
    // and nothing inside a block the parser refused to make was re-parsed.
    expect(heading?.querySelector('em')).toBeNull();
    expect(heading?.querySelector('h1, h2')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    // The notes keep their markdown — the name reading literally is a property
    // of what the parser was allowed to make of *it*, not of the whole preview.
    expect(preview.querySelector('em')?.textContent).toBe('rendered');
  });

  itDom('emphasis inside the heading still renders', () => {
    // The other half of D2, and the half `name-title-body` did not have: the
    // name's own inline markdown is read here as it is everywhere else.
    //
    // Proof: the heading's body put back to the bare `{name}` this file
    // rendered until 2026-08-29 — the name as plain text — watched failing on
    // `expected undefined to be 'not'`, and `a link in the name is followable
    // from the preview` beside it on `expected undefined to be
    // 'http://x.test/'`. Watched, 2026-08-29.
    const preview = previewOf('*not* a heading', 'notes');

    const heading = preview.querySelector('h1');
    expect(heading?.querySelector('em')?.textContent).toBe('not');
    expect(heading?.textContent).toBe('not a heading');
  });

  itDom('a link in the name is followable from the preview', () => {
    // The one face where it is. In a Name cell the same link is styled text
    // with its href in the tooltip — `inline-markdown.tsx` says why.
    const preview = previewOf('see [the plan](http://x.test/)', 'notes');

    const link = preview.querySelector('h1 a');
    expect(link?.getAttribute('href')).toBe('http://x.test/');
  });

  itDom('the name out-sizes every heading a note makes', () => {
    // Found on a live screen: the browser's default `h2` is 1.5em, so a note
    // opening with `## Risks` stood taller than the 1.05em name above it and
    // read as the preview's title. The name is the document's heading; every
    // heading the notes make renders under it, in their own order.
    //
    // Inline sizes are the production mechanism, so jsdom can see this one: a
    // heading this comparison reads as NaN is one the override no longer
    // reaches, and the browser sizes it over the name. Proof: the `h2` entry
    // deleted from `noteHeadings`, this failed on `expected 1.15 to be greater
    // than NaN`; the note-`h1` entry deleted, on `expected 1.3 to be greater
    // than NaN` for the `# shouted` heading. Watched, 2026-08-09.
    const preview = previewOf('Strip the old wiring', '# shouted\n\n## Risks\n\n### deep');

    const [nameHeading, noteH1] = [...preview.querySelectorAll('h1')];
    const noteH2 = preview.querySelector('h2');
    const noteH3 = preview.querySelector('h3');
    const sizeOf = (heading: HTMLElement | null | undefined): number =>
      parseFloat(heading?.style.fontSize ?? '');

    expect(sizeOf(nameHeading)).toBeGreaterThan(sizeOf(noteH1));
    expect(sizeOf(noteH1)).toBeGreaterThan(sizeOf(noteH2));
    expect(sizeOf(noteH2)).toBeGreaterThan(sizeOf(noteH3));
    // 1em text sits under the deepest sized heading, closing the order.
    expect(sizeOf(noteH3)).toBeGreaterThan(1);
  });

  itDom('renders raw HTML in a note as the text somebody typed', () => {
    const preview = previewOf(
      'Strip',
      '<img src=x onerror="alert(1)"> and <script>alert(2)</script>',
    );

    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('alert(1)');
  });
});
