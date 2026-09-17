import { describe, expect, it } from 'bun:test';

import { effectiveServicesOf, type ServiceLabelled } from './effective-service';
import { effectiveTeamsOf, type TeamsLabelled } from './effective-team';
import { assignedOutsideTeam, builtByNonOwner } from './label-mismatch';

/** A row of a plan carrying both dimensions the signals read. */
interface Row extends ServiceLabelled, TeamsLabelled {}

const row = (
  id: string,
  parentId: string | null,
  labels: { teamIds?: readonly string[]; serviceIds?: readonly string[] } = {},
): Row => ({
  id,
  parentId,
  teamIds: labels.teamIds ?? [],
  serviceIds: labels.serviceIds ?? [],
});

const owned = (
  entries: Record<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> => new Map(Object.entries(entries));

/**
 * The composition both apps have to make — the **effective** reading of each
 * dimension, then the signal over it.
 *
 * Written once here rather than inlined per case because it is the line the
 * signals can be got wrong at: `builtByNonOwner` takes a team set and cannot
 * tell where the caller found it. Its fault is injected below by pointing this
 * helper at `subject.teamIds` — the row's own stored labels — which is
 * `RowFacets.teamIds`' shipped-twice bug, one dimension over.
 */
function signalsFor(
  rows: readonly Row[],
  id: string,
  directory: {
    ownedServicesByTeam?: ReadonlyMap<string, readonly string[]>;
    assigneeIds?: readonly string[];
    teamsByPerson?: ReadonlyMap<string, readonly string[]>;
  } = {},
): { builtByNonOwner: boolean; assignedOutsideTeam: boolean } {
  const teamIds = effectiveTeamsOf(rows).get(id)?.teamIds ?? [];
  const serviceIds = effectiveServicesOf(rows).get(id)?.serviceIds ?? [];
  return {
    builtByNonOwner: builtByNonOwner({
      serviceIds,
      teamIds,
      ownedServicesByTeam: directory.ownedServicesByTeam ?? new Map(),
    }),
    assignedOutsideTeam: assignedOutsideTeam({
      assigneeIds: directory.assigneeIds ?? [],
      teamIds,
      teamsByPerson: directory.teamsByPerson ?? new Map(),
    }),
  };
}

describe('builtByNonOwner', () => {
  it('flags a row whose team owns some other service', () => {
    // The spec's first scenario, verbatim: Platform owns only Auth, and the row
    // it is labelled with delivers Payments. Nothing is refused and no date
    // moves — the plan simply says who built what it does not own, which is the
    // whole of what Dany asked for (2026-08-20 23:18).
    const flagged = builtByNonOwner({
      serviceIds: ['payments'],
      teamIds: ['platform'],
      ownedServicesByTeam: owned({ platform: ['auth'] }),
    });

    expect(flagged).toBe(true);
  });

  it('does not flag a row whose team owns the service', () => {
    const flagged = builtByNonOwner({
      serviceIds: ['payments'],
      teamIds: ['platform'],
      ownedServicesByTeam: owned({ platform: ['auth', 'payments'] }),
    });

    expect(flagged).toBe(false);
  });

  it('flags a row delivering two services when the team owns only one of them', () => {
    // The scope change's rule, in Dany's own terms (2026-08-21): a row is built
    // by a non-owner when **at least one** effective service is missing from
    // the team's owned set. Any rather than every — the mixed row is the one
    // worth seeing, and a rule demanding every service be unowned would go
    // quiet on exactly it while both cases above still passed.
    const flagged = builtByNonOwner({
      serviceIds: ['payments', 'search'],
      teamIds: ['platform'],
      ownedServicesByTeam: owned({ platform: ['payments'] }),
    });

    expect(flagged).toBe(true);
  });

  it('does not flag a row whose every service is owned, across two teams', () => {
    // The other side of the any: each service needs *an* owner among the row's
    // teams, and it need not be the same team for both. Two teams building
    // together, between them owning everything the row delivers, is work
    // sitting inside the ownership.
    const flagged = builtByNonOwner({
      serviceIds: ['payments', 'search'],
      teamIds: ['platform', 'discovery'],
      ownedServicesByTeam: owned({ platform: ['payments'], discovery: ['search'] }),
    });

    expect(flagged).toBe(false);
  });

  it('takes any one owner among several teams as enough', () => {
    // The question is whether the work sits inside somebody's ownership, not
    // whether every team named on the row owns it. A pair building together,
    // one of whom owns the service, is not a non-owner build — and reading it
    // the other way would flag most shared work in a plan where teams
    // collaborate, which is the marker-covers-everything failure one step over
    // from the absence rule below.
    const flagged = builtByNonOwner({
      serviceIds: ['payments'],
      teamIds: ['design', 'platform'],
      ownedServicesByTeam: owned({ platform: ['payments'] }),
    });

    expect(flagged).toBe(false);
  });

  it('treats a team the ownership map has never heard of as owning nothing', () => {
    // A team with no `team_service` rows is absent from the map, not present
    // with an empty set — the directory read builds it from the join. "Nobody
    // has filled the map in" and "this team owns nothing" are the same fact
    // about the directory and get the same answer, deliberately.
    const flagged = builtByNonOwner({
      serviceIds: ['payments'],
      teamIds: ['platform'],
      ownedServicesByTeam: new Map(),
    });

    expect(flagged).toBe(true);
  });
});

describe('assignedOutsideTeam', () => {
  it('flags a person who belongs to no team at all', () => {
    const flagged = assignedOutsideTeam({
      assigneeIds: ['ada'],
      teamIds: ['platform'],
      teamsByPerson: new Map(),
    });

    expect(flagged).toBe(true);
  });

  it('flags a person who belongs only to other teams', () => {
    const flagged = assignedOutsideTeam({
      assigneeIds: ['ada'],
      teamIds: ['platform'],
      teamsByPerson: owned({ ada: ['design'] }),
    });

    expect(flagged).toBe(true);
  });

  it('does not flag a person who belongs to one of the row’s teams', () => {
    const flagged = assignedOutsideTeam({
      assigneeIds: ['ada'],
      teamIds: ['design', 'platform'],
      teamsByPerson: owned({ ada: ['platform'] }),
    });

    expect(flagged).toBe(false);
  });

  it('flags the row when one of several assignees is outside', () => {
    // Some, not every. One outsider on a row is the fact worth showing, and a
    // row where everybody is outside is not a different kind of event.
    const flagged = assignedOutsideTeam({
      assigneeIds: ['ada', 'kat'],
      teamIds: ['platform'],
      teamsByPerson: owned({ ada: ['platform'], kat: ['design'] }),
    });

    expect(flagged).toBe(true);
  });

  it('names which assignee is outside through the same function', () => {
    // Task 7.2's hover sentence has to say *who*, and this is how it says it —
    // the same rule over a one-element set, so there is no second export and no
    // second place for the rule to drift. Asserted here rather than left as a
    // JSDoc suggestion, because a documented technique nobody runs is a guess.
    const teamIds = ['platform'];
    const teamsByPerson = owned({ ada: ['platform'], kat: ['design'], bo: [] });

    const outside = ['ada', 'kat', 'bo'].filter((id) =>
      assignedOutsideTeam({ assigneeIds: [id], teamIds, teamsByPerson }),
    );

    expect(outside).toEqual(['kat', 'bo']);
  });
});

describe('both signals, over the effective reading', () => {
  it('reads the inherited team, not the row’s own stored labels', () => {
    // **Task 5.2's watched red.** The child states no team and its own service;
    // the team doing the work is the parent's. Point `signalsFor` at
    // `subject.teamIds` instead of `effectiveTeamsOf` and both halves go false
    // — the row falls silent exactly where the inheritance is doing the work,
    // which is the class of bug `RowFacets.teamIds` says this repo has shipped
    // twice.
    //
    // Watched 2026-08-21: the injection is in `signalsFor` above, because at
    // this chunk **no production caller exists yet** — `grep -rn
    // 'builtByNonOwner\|assignedOutsideTeam' apps/` finds only the be-01 route
    // case for 5.4. The same red at its real site is task 6.2, where
    // `RowFacets` computes these per row. So this case is the vocabulary's
    // regression guard and 6.2 is the proof; said out loud rather than left for
    // a reader to assume the stronger thing.
    const rows = [
      row('parent', null, { teamIds: ['platform'] }),
      row('leaf', 'parent', { serviceIds: ['payments'] }),
    ];

    const found = signalsFor(rows, 'leaf', {
      ownedServicesByTeam: owned({ platform: ['auth'] }),
      assigneeIds: ['ada'],
      teamsByPerson: owned({ ada: ['design'] }),
    });

    expect(found).toEqual({ builtByNonOwner: true, assignedOutsideTeam: true });
  });

  it('reads the inherited service too', () => {
    // The other dimension of the same rule: the service is the parent's and the
    // team is the leaf's own. A signal reading `work_item.service_id` off the
    // row would find null here and flag nothing.
    const rows = [
      row('parent', null, { serviceIds: ['payments'] }),
      row('leaf', 'parent', { teamIds: ['design'] }),
    ];

    const found = signalsFor(rows, 'leaf', {
      ownedServicesByTeam: owned({ design: ['checkout'] }),
    });

    expect(found.builtByNonOwner).toBe(true);
  });

  it('flags nothing on a row with a service and no team anywhere above it', () => {
    // **5.3, first half.** The row says what it delivers and nobody has said
    // who is doing it. There is no team to compare an owner against, so there
    // is no mismatch — not an unknown one, not a suspected one, none.
    const rows = [row('root', null, { serviceIds: ['payments'] })];

    const found = signalsFor(rows, 'root', {
      ownedServicesByTeam: owned({ platform: ['payments'] }),
      assigneeIds: ['ada'],
      teamsByPerson: new Map(),
    });

    expect(found).toEqual({ builtByNonOwner: false, assignedOutsideTeam: false });
  });

  it('names which of a row’s services are the unowned ones', () => {
    // Task 7.2's hover sentence, and the reason there is no third export: the
    // filter documented on `builtByNonOwner` is the same rule over a
    // one-element set, so "which" and "whether" cannot drift apart. Asserted
    // here rather than in the cell that renders it, because it is a claim about
    // the rule and not about a tooltip.
    const asked = {
      serviceIds: ['payments', 'search', 'auth'],
      teamIds: ['platform'],
      ownedServicesByTeam: owned({ platform: ['search'] }),
    };

    const offending = asked.serviceIds.filter((id) =>
      builtByNonOwner({ ...asked, serviceIds: [id] }),
    );

    expect(offending).toEqual(['payments', 'auth']);
    // And the whole-row answer agrees with the list being non-empty, which is
    // the property that keeps a marker from appearing with nothing to name.
    expect(builtByNonOwner(asked)).toBe(offending.length > 0);
  });

  it('flags nothing on a row with a team and no service', () => {
    // **5.3, second half.** Most rows in a young plan are this row. If absence
    // flagged, the marker would land on nearly all of them on the day the
    // feature shipped, and a marker that covers a plan is one its readers learn
    // to skip.
    const rows = [row('root', null, { teamIds: ['platform'] })];

    const found = signalsFor(rows, 'root', {
      ownedServicesByTeam: owned({ platform: ['auth'] }),
    });

    expect(found.builtByNonOwner).toBe(false);
  });

  it('flags nothing on a row with a team and nobody assigned', () => {
    // **5.3, third half.** Unassigned work is not assigned outside the team;
    // the readiness badge is what says a row has nobody on it, and this signal
    // deliberately does not say it a second time in a different colour.
    const rows = [row('root', null, { teamIds: ['platform'] })];

    const found = signalsFor(rows, 'root', {
      assigneeIds: [],
      teamsByPerson: owned({ ada: ['design'] }),
    });

    expect(found.assignedOutsideTeam).toBe(false);
  });
});
