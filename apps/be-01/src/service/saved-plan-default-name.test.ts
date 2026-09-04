import { describe, expect, it } from 'bun:test';

import { defaultSavedPlanName } from './saved-plan-default-name';

/**
 * A-1's default name (`openspec/changes/saved-plans/design.md`): "save writes
 * immediately with the server timestamp as the default name, and naming is an
 * edit afterwards, not a modal".
 *
 * The whole point of these cases is that the name is a **lossless rendering of
 * `created_at`** and of nothing else. A name that merely looks like a timestamp
 * would satisfy A-1's wording and break its intent: the user reads the name and
 * the date column side by side, and if they can disagree, one of them is lying.
 */
describe('the default name a save falls back to', () => {
  it('renders the epoch second it was given, in UTC, to the second', () => {
    // 2026-09-04T07:40:12Z. Chosen with a two-digit month, day, hour, minute
    // and second so a zero-padding fault cannot hide behind a wide field.
    expect(defaultSavedPlanName(1_788_507_612)).toBe('2026-09-04 07:40:12 UTC');
  });

  it('pads every field, so names sort in the order the plans were saved', () => {
    // 2026-01-02T03:04:05Z — every field single-digit at once. Unpadded, this
    // renders `2026-1-2 3:4:5 UTC`, which sorts *after* the case above as a
    // string while being months earlier in fact. The shelf lists by
    // `created_at` today, but a name that misorders itself is a trap for the
    // first caller that sorts by the label it can see.
    expect(defaultSavedPlanName(1_767_323_045)).toBe('2026-01-02 03:04:05 UTC');
  });

  it('is not the caller local time of whoever formats it', () => {
    // The stated reason `saved-plan-api.ts` refuses to default the name in the
    // client: no clock but the one that stamps `created_at` may name the
    // record. Asserted by construction rather than by trusting the two literals
    // above — this box runs in UTC, so an implementation reading local fields
    // would pass every case here and fail in a deployment that does not.
    const seconds = 1_788_507_612;
    const utc = new Date(seconds * 1000);
    expect(defaultSavedPlanName(seconds)).toBe(
      `${String(utc.getUTCFullYear())}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-` +
        `${String(utc.getUTCDate()).padStart(2, '0')} ` +
        `${String(utc.getUTCHours()).padStart(2, '0')}:` +
        `${String(utc.getUTCMinutes()).padStart(2, '0')}:` +
        `${String(utc.getUTCSeconds()).padStart(2, '0')} UTC`,
    );
  });

  it('is never empty, so the default satisfies the same minLength the route asks of a caller', () => {
    // The route's body schema is `minLength: 1` for a supplied name. The
    // default is not validated by that schema — it is chosen after validation —
    // so this is the only place the same floor is asserted for it.
    expect(defaultSavedPlanName(0).length).toBeGreaterThan(0);
  });
});
