import { describe, expect, it } from 'bun:test';

import {
  AncestryCycleError,
  effectiveSetOf,
  type Nested,
  PluralMembershipError,
  soleMemberOf,
} from './effective-set';

interface Row extends Nested {
  teamIds: readonly string[];
  serviceIds: readonly string[];
}

const row = (
  id: string,
  parentId: string | null,
  teamIds: readonly string[],
  serviceIds: readonly string[] = [],
): Row => ({ id, parentId, teamIds, serviceIds });

const teamsOf = (each: Row): readonly string[] => each.teamIds;
const servicesOf = (each: Row): readonly string[] => each.serviceIds;

describe('effectiveSetOf', () => {
  it('reaches an unlabelled leaf from the parent above it', () => {
    const rows = [row('parent', null, ['platform']), row('leaf', 'parent', [])];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.get('leaf')).toEqual({ memberIds: ['platform'], fromId: 'parent' });
    expect(found.get('parent')).toEqual({ memberIds: ['platform'], fromId: 'parent' });
  });

  it('lets a leaf’s own set beat its parent’s, in both directions', () => {
    // Most-specific wins, and deliberately not the floor rule: a floor takes
    // `Math.max` because it is a hard constraint, and a label is a statement
    // about whose work this is.
    const rows = [
      row('parent', null, ['platform']),
      row('leaf', 'parent', ['payments']),
      row('other-parent', null, ['payments']),
      row('other-leaf', 'other-parent', ['platform']),
    ];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.get('leaf')?.memberIds).toEqual(['payments']);
    expect(found.get('leaf')?.fromId).toBe('leaf');
    expect(found.get('other-leaf')?.memberIds).toEqual(['platform']);
  });

  it('overrides the ancestor’s set whole rather than adding to it', () => {
    // Dany, 2026-08-13: inheritance is override, not union. A union has no way
    // to say "not that one after all", and every row under a labelled root
    // would accumulate everything written above it.
    //
    // Proof: the walk's `own.length > 0` arm replaced by a union of the row's
    // own members with its parent's, and this failed on
    // `expect(received).toEqual(expected)` with `memberIds` back as
    // `["payments", "platform"]` where `["payments"]` was owed. It takes three
    // more with it — `lets a leaf's own set beat its parent's`, `gives the
    // nearer ancestor's set to a leaf between two` and `resolves each dimension
    // on its own` — for 8 pass / 4 fail. Watched 2026-08-14.
    const rows = [row('parent', null, ['platform', 'design']), row('leaf', 'parent', ['payments'])];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.get('leaf')?.memberIds).toEqual(['payments']);
  });

  it('carries every member of the set that wins, not just its first', () => {
    // The arity is the whole change. A walk that resolved to one id would be
    // `effectiveTeamOf` wearing a set's type.
    const rows = [row('parent', null, ['platform', 'design']), row('leaf', 'parent', [])];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.get('leaf')).toEqual({ memberIds: ['platform', 'design'], fromId: 'parent' });
  });

  it('gives the nearer ancestor’s set to a leaf between two', () => {
    const rows = [
      row('grandparent', null, ['platform']),
      row('parent', 'grandparent', ['payments']),
      row('leaf', 'parent', []),
    ];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.get('leaf')).toEqual({ memberIds: ['payments'], fromId: 'parent' });
  });

  it('resolves each dimension on its own, so a row can override one and inherit the other', () => {
    // Q4, confirmed 2026-08-13: the two dimensions inherit independently, and
    // an empty set is unstated rather than "deliberately none".
    //
    // Proof: `effectiveSetOf` made to read `row.teamIds` directly instead of
    // calling its accessor — the shortcut a generic walk invites, and one that
    // is right about every team and silently wrong about every other dimension.
    // This failed alone, 11 pass / 1 fail, on `{fromId: "parent", memberIds:
    // ["platform"]}` where `{fromId: "leaf", memberIds: ["auth"]}` was owed:
    // the leaf reported inheriting its parent's *team* as its service. Watched
    // 2026-08-14.
    const rows = [
      row('parent', null, ['platform'], ['payments']),
      row('leaf', 'parent', [], ['auth']),
    ];

    const teams = effectiveSetOf(rows, teamsOf);
    const services = effectiveSetOf(rows, servicesOf);

    expect(teams.get('leaf')).toEqual({ memberIds: ['platform'], fromId: 'parent' });
    expect(services.get('leaf')).toEqual({ memberIds: ['auth'], fromId: 'leaf' });
  });

  it('leaves a row with an empty set all the way up absent, rather than guessing one', () => {
    const rows = [row('parent', null, []), row('leaf', 'parent', [])];

    const found = effectiveSetOf(rows, teamsOf);

    expect(found.size).toBe(0);
  });

  it('names the ancestor the set came from, so a reader can be told', () => {
    // The `fromId` half of the reading. Without it, "Platform — inherited from
    // 010 Backend" cannot be said and every consumer showing an inherited
    // label would be showing an unexplained one.
    const rows = [
      row('a', null, ['platform']),
      row('b', 'a', []),
      row('c', 'b', []),
      row('d', 'c', []),
    ];

    const found = effectiveSetOf(rows, teamsOf);

    for (const id of ['b', 'c', 'd']) expect(found.get(id)?.fromId).toBe('a');
  });

  it('refuses a parent chain that runs in a circle', () => {
    // R5. A cycle has no nearest ancestor, so there is no set to fall back
    // to — and without the guard the walk does not come back at all, which is
    // why the assertion is on the throw and the injected fault was watched
    // under a test timeout rather than as a wrong answer.
    const rows = [row('a', 'b', []), row('b', 'a', [])];

    expect(() => effectiveSetOf(rows, teamsOf)).toThrow(AncestryCycleError);
  });

  it('answers for a row whose parent is not in the list', () => {
    // A parent from another project, or one that has been removed: the walk
    // runs out of rows rather than throwing, and the row is simply unlabelled.
    const rows = [row('orphan', 'elsewhere', [])];

    expect(effectiveSetOf(rows, teamsOf).size).toBe(0);
  });
});

describe('soleMemberOf', () => {
  it('answers the one member, and null for none', () => {
    expect(soleMemberOf(['platform'], 'row 010')).toBe('platform');
    expect(soleMemberOf([], 'row 010')).toBeNull();
  });

  it('refuses a plural set rather than spending its first member', () => {
    // The reader that took `[0]` here is the silent wrong answer this whole
    // narrowing exists to prevent: a plan bounded by one of its three teams,
    // with nothing on screen or in a log to say the other two were dropped.
    //
    // Proof: the length check removed, so the function returns `memberIds[0]`,
    // and this failed on `expected [Function] to throw PluralMembershipError`
    // while every other test in this file stayed green; watched 2026-08-14.
    expect(() => soleMemberOf(['platform', 'design'], 'row 010')).toThrow(PluralMembershipError);
    expect(() => soleMemberOf(['platform', 'design'], 'row 010')).toThrow(
      'row 010 names 2 resources (platform, design), and this release reads one',
    );
  });
});
