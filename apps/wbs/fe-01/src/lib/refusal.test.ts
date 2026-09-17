import { describe, expect, it } from 'vitest';

import { type RefusalWords, sentenceForRefusal } from './refusal';
import {
  CAPACITY_REFUSALS,
  directoryRefusalSentence,
  PRIORITY_BAND_REFUSALS,
  STEP_REFUSALS,
} from './wbs-api';

/** A surface with one of everything, so each rule can be asked about on its own. */
const WORDS: RefusalWords = {
  sentences: { not_found: 'gone', size_must_be_at_most_9: 'exactly this' },
  limits: [
    { prefix: 'size_must_be_at_most_', says: (limit) => `at most ${limit}` },
    { prefix: 'bands_must_number_', says: (limit) => `exactly ${limit}` },
  ],
  serverFailure: 'the server could not',
  otherwise: (code) => `unworded (${code})`,
};

describe('one refusal lookup', () => {
  it('takes an exact code before a prefix that also matches it', () => {
    // Order is the one thing five copies of this could have disagreed about,
    // and `size_must_be_at_most_9` is a code both rules claim.
    expect(sentenceForRefusal(WORDS, 'size_must_be_at_most_9')).toBe('exactly this');
  });

  it('hands a limit the number be-01 spelled into the code', () => {
    expect(sentenceForRefusal(WORDS, 'size_must_be_at_most_1000')).toBe('at most 1000');
    expect(sentenceForRefusal(WORDS, 'bands_must_number_5')).toBe('exactly 5');
  });

  it('words the whole 5xx family, and no other status', () => {
    expect(sentenceForRefusal(WORDS, 'http_500')).toBe('the server could not');
    expect(sentenceForRefusal(WORDS, 'http_502')).toBe('the server could not');
    // 401 and 403 are not this family and must not read as a server failure —
    // a sentence about the server over an expired session sends the reader
    // looking in the wrong place.
    expect(sentenceForRefusal(WORDS, 'http_401')).toBe('unworded (http_401)');
  });

  it('carries the code when nobody has worded the refusal', () => {
    expect(sentenceForRefusal(WORDS, 'something_new')).toBe('unworded (something_new)');
  });

  it('reads a 5xx through the fallback on a surface that words no server failure', () => {
    // Two of the six surfaces do exactly this, on purpose, and it is why
    // `serverFailure` is optional rather than defaulted here.
    const quiet: RefusalWords = { sentences: {}, otherwise: () => 'that did not land' };
    expect(sentenceForRefusal(quiet, 'http_500')).toBe('that did not land');
  });
});

/**
 * The sentences as they stand, pinned before the shape underneath them moved.
 *
 * Not every arm — the point is one line per surface plus the arms the surfaces
 * disagree about, so that a refactor of the lookup cannot quietly reword a
 * refusal a reader has learned to recognise.
 *
 * Proof: `sentenceForRefusal`'s exact-code lookup and its limit loop swapped,
 * watched failing on `expected 'at most 9' to be 'exactly this'` in `takes an
 * exact code before a prefix that also matches it` — `1 failed | 8 passed`. The
 * four surfaces stayed green under that fault, which is the reason the case
 * above uses a code both rules claim: none of the real tables holds one today,
 * and the day one does, the order has to already be settled. Observed
 * 2026-09-02.
 */
describe('the sentences each surface says', () => {
  it('words a step refusal, and a 5xx through its fallback', () => {
    expect(sentenceForRefusal(STEP_REFUSALS, 'taken')).toBe(
      'That name is already a step on this plan.',
    );
    // No 5xx arm on this surface, stated in `STEP_REFUSALS` and asserted here
    // so that adding one is a visible change rather than a silent one.
    expect(sentenceForRefusal(STEP_REFUSALS, 'http_502')).toBe(
      'The step could not be changed (http_502).',
    );
  });

  it('words a directory refusal from the surviving name, never from the draft', () => {
    expect(directoryRefusalSentence({ reason: 'taken', survivingName: 'Kat' })).toBe(
      '“Kat” is already in the directory, so nothing was renamed.',
    );
    expect(directoryRefusalSentence({ reason: 'refused', code: 'name_required' })).toBe(
      'A name cannot be blank.',
    );
  });

  it('words a capacity ceiling from the number be-01 sent', () => {
    expect(sentenceForRefusal(CAPACITY_REFUSALS, 'size_must_be_at_most_1000')).toBe(
      'A plan can have at most 1000 of one team at work at once.',
    );
    expect(sentenceForRefusal(CAPACITY_REFUSALS, 'http_500')).toBe(
      'The server could not save that. Try again.',
    );
  });

  it('words a ladder refusal, including the two codes with numbers in them', () => {
    expect(sentenceForRefusal(PRIORITY_BAND_REFUSALS, 'bands_must_number_5')).toBe(
      'A priority ladder has exactly 5 bands — one cannot be added or taken away.',
    );
    expect(
      sentenceForRefusal(PRIORITY_BAND_REFUSALS, 'band_label_must_be_1_to_40_characters'),
    ).toBe("A band's name is 1 to 40 characters.");
  });
});
