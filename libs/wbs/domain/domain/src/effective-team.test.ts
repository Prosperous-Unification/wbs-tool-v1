import { describe, expect, it } from 'bun:test';

import { effectiveTeamsOf, TeamAncestryCycleError, type TeamsLabelled } from './effective-team';

const row = (id: string, parentId: string | null, ...teamIds: string[]): TeamsLabelled => ({
  id,
  parentId,
  teamIds,
});

describe('effectiveTeamsOf', () => {
  it('reaches an unlabelled leaf from the parent above it', () => {
    const rows = [row('parent', null, 'platform'), row('leaf', 'parent')];

    const found = effectiveTeamsOf(rows);

    expect(found.get('leaf')).toEqual({ teamIds: ['platform'], fromId: 'parent' });
    expect(found.get('parent')).toEqual({ teamIds: ['platform'], fromId: 'parent' });
  });

  it('inherits an ancestor’s whole set, not its first member', () => {
    // The fault this replaces is the one that moves dates rather than failing:
    // the adapter spends slots in whatever set it is handed, so a leaf given
    // one team of two is scheduled against a pool the plan never narrowed to.
    const rows = [row('parent', null, 'design', 'platform'), row('leaf', 'parent')];

    const found = effectiveTeamsOf(rows);

    expect(found.get('leaf')?.teamIds).toEqual(['design', 'platform']);
  });

  it('lets a leaf’s own set beat its parent’s, whole and in both directions', () => {
    // Override, not union (Dany, 2026-08-13): the leaf states `payments` and is
    // on `payments` **alone**, with no trace of the two teams above it. Most
    // specific wins, and deliberately not the floor rule — a floor takes
    // `Math.max` because it is a hard constraint, and a label is a statement
    // about whose work this is.
    const rows = [
      row('parent', null, 'design', 'platform'),
      row('leaf', 'parent', 'payments'),
      row('other-parent', null, 'payments'),
      row('other-leaf', 'other-parent', 'platform'),
    ];

    const found = effectiveTeamsOf(rows);

    expect(found.get('leaf')).toEqual({ teamIds: ['payments'], fromId: 'leaf' });
    expect(found.get('other-leaf')?.teamIds).toEqual(['platform']);
  });

  it('gives the nearer ancestor’s set to a leaf between two', () => {
    const rows = [
      row('grandparent', null, 'platform', 'design'),
      row('parent', 'grandparent', 'payments'),
      row('leaf', 'parent'),
    ];

    const found = effectiveTeamsOf(rows);

    expect(found.get('leaf')).toEqual({ teamIds: ['payments'], fromId: 'parent' });
  });

  it('reads an empty set as unstated, so it inherits rather than meaning none', () => {
    // The whole of Q4's answer, in one assertion: `[]` is _unstated_ and there
    // is no second state meaning "deliberately no team". A row whose set is
    // empty is on its ancestor's, and a plan with nothing above it is absent
    // from the map — one spelling of unstated, as `null` was one spelling.
    const inherits = effectiveTeamsOf([row('parent', null, 'platform'), row('leaf', 'parent')]);
    expect(inherits.get('leaf')?.teamIds).toEqual(['platform']);

    const nothing = effectiveTeamsOf([row('parent', null), row('leaf', 'parent')]);
    expect(nothing.size).toBe(0);
  });

  it('names the ancestor the set came from, so a reader can be told', () => {
    // The `fromId` half of the reading. Without it, "Platform — inherited from
    // 010 Backend" cannot be said and every consumer showing an inherited
    // label would be showing an unexplained one.
    const rows = [row('a', null, 'platform'), row('b', 'a'), row('c', 'b'), row('d', 'c')];

    const found = effectiveTeamsOf(rows);

    for (const id of ['b', 'c', 'd']) expect(found.get(id)?.fromId).toBe('a');
  });

  it('resolves a chain of unlabelled rows once, and hands each of them the same answer', () => {
    // The memoisation the docstring claims, asserted the only way it is
    // observable from outside: every row the deepest walk passed through holds
    // **the same object**, which a per-row re-walk cannot produce. Without it
    // the walk is quadratic in the depth and nothing else in the suite notices.
    //
    // The order of `rows` is load-bearing and the test is vacuous without it.
    // Deepest first, so `d`'s walk is the one that reaches the label and the
    // rows above it are answered by that walk rather than by their own. Listed
    // shallowest first, every row is already in the map before anything walks
    // through it, the `already` short circuit hands out the same object anyway,
    // and deleting the memoisation changes nothing observable — watched
    // passing that way on 2026-08-14 before this comment was written.
    const rows = [row('d', 'c'), row('c', 'b'), row('b', 'a'), row('a', null, 'platform')];

    const found = effectiveTeamsOf(rows);

    const answer = found.get('d');
    expect(answer).toBeDefined();
    for (const id of ['b', 'c']) expect(found.get(id)).toBe(answer);
  });

  it('refuses a parent chain that runs in a circle', () => {
    // R5. A cycle has no nearest ancestor, so there is no set to fall back to —
    // and without the guard the walk does not come back at all, which is why
    // the assertion is on the throw and the injected fault was watched under a
    // test timeout rather than as a wrong answer.
    const rows = [row('a', 'b'), row('b', 'a')];

    expect(() => effectiveTeamsOf(rows)).toThrow(TeamAncestryCycleError);
  });

  it('answers for a row whose parent is not in the list', () => {
    // A parent from another project, or one that has been removed: the walk
    // runs out of rows rather than throwing, and the row is simply unlabelled.
    const rows = [row('orphan', 'elsewhere')];

    expect(effectiveTeamsOf(rows).size).toBe(0);
  });
});
