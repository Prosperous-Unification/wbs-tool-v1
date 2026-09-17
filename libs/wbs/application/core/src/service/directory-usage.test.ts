import { describe, expect, it } from 'bun:test';

import type { DirectoryUsageRows, LabelledWorkItem } from '../index';
import { labelledRow } from '../testing/work-item-fixture';
import { directoryUsageOfTeam } from './directory-usage';

/**
 * `directoryUsageOfTeam` over rows built by hand — which is the only place a
 * work item on **two** teams can be stated at all until R2-4, since every write
 * path states one. The rest of the removal's behaviour is asserted against real
 * SQLite in `directory.service.test.ts`; what is here is the arity.
 */
function labelled(id: string, parentId: string | null, ...teamIds: string[]): LabelledWorkItem {
  return labelledRow({
    id,
    parentId,
    name: id,
    projectId: 'p1',
    serviceTeamId: teamIds.at(0) ?? null,
    teamIds,
  });
}

function rowsOf(
  workItems: LabelledWorkItem[],
  capacityOf: ReadonlyMap<string, number> = new Map(),
): DirectoryUsageRows {
  return {
    workItems,
    projects: [{ id: 'p1', name: 'Rollout' }],
    assignments: [],
    steps: [],
    people: [],
    members: [],
    capacityOf,
  };
}

describe('directoryUsageOfTeam over a set', () => {
  it('names a work item labelled with the team, whichever member of its set it is', () => {
    // The membership test, and the fault it replaces reads as correct: with
    // `teamIds[0] === teamId`, a work item on Backend **and** Design loses its
    // Design label to a removal that told nobody. The confirmation would say
    // "nothing points at this" about a row it is about to edit.
    const rows = rowsOf([labelled('w1', null, 'backend', 'design')]);

    for (const teamId of ['backend', 'design']) {
      expect(directoryUsageOfTeam(rows, teamId).projects).toEqual([
        {
          id: 'p1',
          name: 'Rollout',
          workItems: [{ id: 'w1', number: '010', name: 'w1', effects: [{ kind: 'label_nulled' }] }],
        },
      ]);
    }
  });

  it('says nothing about a team no row in the set names', () => {
    const rows = rowsOf([labelled('w1', null, 'backend', 'design')]);

    expect(directoryUsageOfTeam(rows, 'platform').projects).toEqual([]);
  });

  it('releases the capacity of an inherited set, on either member', () => {
    // The second reader of the set in this function: the effective one, which
    // reaches the leaf that carries no label of its own. A leaf under a parent
    // on two sized teams draws from both pools, so either removal moves its
    // dates and either must be named.
    const rows = rowsOf(
      [labelled('parent', null, 'backend', 'design'), labelled('leaf', 'parent')],
      new Map([['p1', 2]]),
    );

    for (const teamId of ['backend', 'design']) {
      const named = directoryUsageOfTeam(rows, teamId).projects[0]?.workItems ?? [];
      expect(named.map((each) => each.id)).toEqual(['parent', 'leaf']);
      expect(named.at(1)?.effects).toEqual([
        { kind: 'capacity_released', size: 2, fromId: 'parent' },
      ]);
    }
  });
});
