import { describe, expect, it } from 'vitest';

import { splitMention } from './mention';

describe('splitting a folded estimate cell’s text', () => {
  it('is all estimate while nobody has typed an @', () => {
    expect(splitMention('2/3/8')).toEqual({ estimate: '2/3/8', mention: null });
    expect(splitMention('')).toEqual({ estimate: '', mention: null });
  });

  it('holds the two halves apart from the moment the @ is typed', () => {
    // The whole reason this exists: the estimate parser must never see the
    // mention. `2/3/8@` is a finished trio and an empty search, not the
    // four-part entry `parseTrioShorthand` would refuse.
    expect(splitMention('2/3/8@')).toEqual({ estimate: '2/3/8', mention: '' });
    expect(splitMention('2/3/8@ka')).toEqual({ estimate: '2/3/8', mention: 'ka' });
  });

  it('takes a mention with no estimate in front of it', () => {
    // Assigning somebody to a row nobody has estimated is an ordinary gesture,
    // and an empty estimate half is the one that clears a stored trio — which
    // is why it must not be confused with "no estimate half at all".
    expect(splitMention('@ka')).toEqual({ estimate: '', mention: 'ka' });
  });

  it('splits at the first @, so a second one is part of what is being searched for', () => {
    // Nobody types two mentions in one estimate cell. Splitting at the last
    // one would make `@a@b` a search for `b` against an estimate of `@a`,
    // which is an estimate that cannot parse and a complaint nobody caused.
    expect(splitMention('@a@b')).toEqual({ estimate: '', mention: 'a@b' });
  });

  it('leaves the spacing of both halves exactly as typed', () => {
    // Neither half is trimmed here. The estimate half is a draft somebody is
    // still typing — trimming it would edit an estimate, which this tool does
    // not do — and the search half is trimmed where it is compared, not here.
    expect(splitMention(' 2 / 3 / 8 @ ka ')).toEqual({
      estimate: ' 2 / 3 / 8 ',
      mention: ' ka ',
    });
  });
});
