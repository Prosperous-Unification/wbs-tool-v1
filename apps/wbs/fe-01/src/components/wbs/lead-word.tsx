import type { ReactNode } from 'react';

/**
 * The tones a lead word can be drawn in. `done` is the one tone today: the
 * table's `--status-done`, so `Done` reads in the same green wherever it is
 * said — the status card, the row's ⋯ menu, the strip and the tick.
 */
export type LeadTone = 'done';

const LEAD_TONE_COLOR: Readonly<Record<LeadTone, string>> = { done: 'var(--status-done)' };

/** A word to draw bold inside a sentence, and the tone to draw it in, if any. */
export interface LeadWord {
  word: string;
  tone?: LeadTone;
}

/**
 * A sentence with its lead word drawn **bold** and, with a tone, in that tone's
 * colour — the first occurrence of the word, the rest of the sentence as it
 * was. Plain words when there is no lead or the word is not in the sentence:
 * a lead that has come apart from its sentence is drawn plain rather than
 * thrown, because a card or a menu line is not the place a mismatch should
 * take the page down.
 *
 * One renderer for the status card (`hint.tsx`) and the row menu
 * (`actions-menu.tsx`), so `Unknown` and `Done` are said the same way on both
 * (Dany, 2026-09-13: "standardise - Unknown and Done from capital letter,
 * Unknown bold Done bold + green … same style in the actions menu").
 */
export function withLeadWord(words: string, lead: LeadWord | null | undefined): ReactNode {
  if (lead === null || lead === undefined || lead.word === '') return words;
  const at = words.indexOf(lead.word);
  if (at === -1) return words;
  return (
    <>
      {words.slice(0, at)}
      <strong
        data-lead-word=""
        style={lead.tone === undefined ? undefined : { color: LEAD_TONE_COLOR[lead.tone] }}
      >
        {lead.word}
      </strong>
      {words.slice(at + lead.word.length)}
    </>
  );
}
