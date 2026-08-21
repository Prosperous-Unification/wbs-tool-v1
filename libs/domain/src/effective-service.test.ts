import { describe, expect, it } from 'bun:test';

import {
  effectiveServicesOf,
  ServiceAncestryCycleError,
  type ServiceLabelled,
} from './effective-service';
import { effectiveTagsOf } from './effective-tag';
import { effectiveTeamsOf } from './effective-team';

const row = (id: string, parentId: string | null, serviceId: string | null = null): ServiceLabelled => ({
  id,
  parentId,
  serviceId,
});

describe('effectiveServicesOf', () => {
  it('reaches a leaf with no service from the parent above it', () => {
    const rows = [row('parent', null, 'payments'), row('leaf', 'parent')];

    const found = effectiveServicesOf(rows);

    expect(found.get('leaf')).toEqual({ serviceId: 'payments', fromId: 'parent' });
    expect(found.get('parent')).toEqual({ serviceId: 'payments', fromId: 'parent' });
  });

  it('lets a leaf’s own service beat its parent’s, in both directions', () => {
    // Override, not union — R2's Q4, confirmed for teams on 2026-08-13, taken
    // unchanged for tags and unchanged again here. Single-valued makes the
    // union arm harder to see and no less wrong: a row that says `checkout`
    // is delivered by `checkout` **alone**, with no trace of the `payments`
    // above it.
    const rows = [
      row('parent', null, 'payments'),
      row('leaf', 'parent', 'checkout'),
      row('other-parent', null, 'checkout'),
      row('other-leaf', 'other-parent', 'payments'),
    ];

    const found = effectiveServicesOf(rows);

    expect(found.get('leaf')).toEqual({ serviceId: 'checkout', fromId: 'leaf' });
    expect(found.get('other-leaf')).toEqual({ serviceId: 'payments', fromId: 'other-leaf' });
  });

  it('gives the nearer ancestor’s service to a leaf between two', () => {
    const rows = [
      row('grandparent', null, 'payments'),
      row('parent', 'grandparent', 'checkout'),
      row('leaf', 'parent'),
    ];

    const found = effectiveServicesOf(rows);

    expect(found.get('leaf')).toEqual({ serviceId: 'checkout', fromId: 'parent' });
  });

  it('reads a null column as unstated, so it inherits rather than meaning no service', () => {
    // `null` is _unstated_ and there is no second state meaning "deliberately
    // unassigned". A row whose column is null is on its ancestor's service, and
    // a plan with nothing above it is absent from the map — one spelling of
    // unstated, the same call the other two dimensions made.
    const inherits = effectiveServicesOf([row('parent', null, 'payments'), row('leaf', 'parent')]);
    expect(inherits.get('leaf')?.serviceId).toBe('payments');

    const nothing = effectiveServicesOf([row('parent', null), row('leaf', 'parent')]);
    expect(nothing.size).toBe(0);
  });

  it('never answers with a null service, so absence has one spelling', () => {
    // The property `EffectiveServices.serviceId` states as `never null`, and the
    // one a consumer would otherwise have to handle twice. Every entry in the
    // map is a real id; the rows with no service anywhere above them are simply
    // not in it.
    const rows = [row('a', null, 'payments'), row('b', 'a'), row('elsewhere', null)];

    const found = effectiveServicesOf(rows);

    expect(found.size).toBe(2);
    for (const answer of found.values()) expect(answer.serviceId).not.toBeNull();
  });

  it('names the ancestor the service came from, so a reader can be told', () => {
    // The `fromId` half of the reading: "Payments — inherited from 010 Backend"
    // cannot be said without it, and a service cell showing an inherited label
    // would be showing an unexplained one.
    const rows = [row('a', null, 'payments'), row('b', 'a'), row('c', 'b'), row('d', 'c')];

    const found = effectiveServicesOf(rows);

    for (const id of ['b', 'c', 'd']) expect(found.get(id)?.fromId).toBe('a');
  });

  it('resolves a chain of rows with no service once, and hands each the same answer', () => {
    // The memoisation, asserted the only way it is observable from outside:
    // every row the deepest walk passed through holds **the same object**, which
    // a per-row re-walk cannot produce. Deepest-first is load-bearing — in tree
    // order the fault is invisible.
    const rows = [row('d', 'c'), row('c', 'b'), row('b', 'a'), row('a', null, 'payments')];

    const found = effectiveServicesOf(rows);

    const answer = found.get('d');
    expect(answer).toBeDefined();
    for (const id of ['b', 'c']) expect(found.get(id)).toBe(answer);
  });

  it('refuses a parent chain that runs in a circle', () => {
    // A cycle has no nearest ancestor, so there is no service to fall back to,
    // and without the guard the walk does not come back at all. The error is
    // this dimension's own: a reader handed a `TagAncestryCycleError` while
    // grouping by service would go looking in the wrong third of the model.
    const rows = [row('a', 'b'), row('b', 'a')];

    expect(() => effectiveServicesOf(rows)).toThrow(ServiceAncestryCycleError);
  });

  it('answers for a row whose parent is not in the list', () => {
    // A parent from another project, or one that has been removed: the walk runs
    // out of rows rather than throwing, and the row simply has no service.
    const rows = [row('orphan', 'elsewhere')];

    expect(effectiveServicesOf(rows).size).toBe(0);
  });
});

describe('the three dimensions, read together', () => {
  /** A row that answers all three questions at once, which every real row does. */
  const all = (
    id: string,
    parentId: string | null,
    teamIds: readonly string[],
    tagIds: readonly string[],
    serviceId: string | null,
  ) => ({ id, parentId, teamIds, tagIds, serviceId });

  it('overrides the service while inheriting teams and tags, and the mirrors', () => {
    // Task 2.4, and the property the design rests on: inheritance is **per
    // dimension, independently**. Two dimensions made that easy to believe;
    // three is where a shared walk would show a leak, because a row now states
    // one dimension while two others are silent.
    //
    // Proof: `effectiveServicesOf` pointed at a second dimension's field and
    // this fails — the service half reads a team id, so a plan grouped by
    // service lists teams under the service heading.
    const rows = [
      all('parent', null, ['platform'], ['regulatory'], 'payments'),
      all('service-only', 'parent', [], [], 'checkout'),
      all('teams-only', 'parent', ['design'], [], null),
      all('tags-only', 'parent', [], ['tech-debt'], null),
    ];

    const teams = effectiveTeamsOf(rows);
    const tags = effectiveTagsOf(rows);
    const services = effectiveServicesOf(rows);

    // States a service, inherits both of the others.
    expect(services.get('service-only')).toEqual({
      serviceId: 'checkout',
      fromId: 'service-only',
    });
    expect(teams.get('service-only')).toEqual({ teamIds: ['platform'], fromId: 'parent' });
    expect(tags.get('service-only')).toEqual({ tagIds: ['regulatory'], fromId: 'parent' });

    // States teams, inherits the service (and the tags).
    expect(teams.get('teams-only')).toEqual({ teamIds: ['design'], fromId: 'teams-only' });
    expect(services.get('teams-only')).toEqual({ serviceId: 'payments', fromId: 'parent' });

    // States tags, inherits the service (and the teams).
    expect(tags.get('tags-only')).toEqual({ tagIds: ['tech-debt'], fromId: 'tags-only' });
    expect(services.get('tags-only')).toEqual({ serviceId: 'payments', fromId: 'parent' });
  });

  it('keeps a row out of one map while it is in the other two', () => {
    // Absence is per dimension too. A plan that states teams and services and
    // no tags has an empty tag map, and every consumer reads that as "nobody has
    // tagged anything" rather than as rows missing from the plan.
    const rows = [
      all('parent', null, ['platform'], [], 'payments'),
      all('leaf', 'parent', [], [], null),
    ];

    expect(effectiveTeamsOf(rows).size).toBe(2);
    expect(effectiveServicesOf(rows).size).toBe(2);
    expect(effectiveTagsOf(rows).size).toBe(0);
  });
});
