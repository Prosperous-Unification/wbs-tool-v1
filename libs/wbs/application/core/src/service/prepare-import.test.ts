import { expect, test } from 'bun:test';

import { planDocumentFixture } from '../testing/plan-document-fixture';
import { prepareImport } from './prepare-import';

const supportsAll = { supports: () => true };
type PlanFixture = ReturnType<typeof planDocumentFixture>;
type Fault = (body: PlanFixture) => void;

function at<T>(values: readonly T[], index = 0): T {
  const value = values.at(index);
  if (value === undefined) throw new Error(`fixture lacks entry ${String(index)}`);
  return value;
}

test('prepares normalized names, indexes and leaf values', () => {
  const prepared = prepareImport(planDocumentFixture(), supportsAll);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.value.settings.name).toBe('Portable plan');
  expect(prepared.value.teamByFileId.get('team-1')?.name).toBe('Billing');
  expect(prepared.value.priorityBands[0]?.label).toBe('Critical');
  expect(prepared.value.calendarMarkers[0]?.name).toBe(' Launch ');
  expect(prepared.value.workItems[0]?.startNoEarlierThanReason).toBe('Release window');
  expect(prepared.value.stepByFileId.get('step-1')?.name).toBe('Build');
  expect(prepared.value.workItems[0]?.estimates).toEqual([
    { stepFileId: 'step-1', optimistic: 1, realistic: 2, pessimistic: 3 },
  ]);
  expect(prepared.value.workItems[0]).not.toHaveProperty('id');
  expect(prepared.value.workItems[0]).not.toHaveProperty('dependsOn');
  expect(prepared.value.capacity[0]).toEqual({ teamFileId: 'team-1', size: 2 });
  expect(prepared.value.dependencies).toEqual([]);
  expect(prepared.value.workItems[0]?.assignments).toEqual([
    { stepFileId: 'step-1', personFileId: 'person-1' },
  ]);
});

const fieldFaults: readonly (readonly [string, Fault, string, string])[] = [
  [
    'blank project name',
    (body) => {
      body.settings.name = '   ';
    },
    'invalid_body',
    'settings.name',
  ],
  [
    'invalid project start',
    (body) => {
      body.settings.startDate = '2026-02-31';
    },
    'invalid_body',
    'settings.startDate',
  ],
  [
    'invalid PERT weights',
    (body) => {
      body.settings.pertWeights = { optimistic: 0, realistic: 0, pessimistic: 0 };
    },
    'invalid_body',
    'settings.pertWeights',
  ],
  [
    'duplicate row id',
    (body) => body.workItems.push(structuredClone(at(body.workItems))),
    'invalid_body',
    'workItems[1].id',
  ],
  [
    'duplicate trimmed tag name',
    (body) => body.directory.tags.push({ id: 'tag-2', name: 'Release' }),
    'invalid_body',
    'directory.tags[1].name',
  ],
  [
    'invalid date',
    (body) => {
      at(body.workItems).deadline = '2026-02-31';
    },
    'invalid_body',
    'workItems[0].deadline',
  ],
  [
    'invalid priority',
    (body) => {
      at(body.workItems).priority = 0;
    },
    'invalid_body',
    'workItems[0].priority',
  ],
  [
    'invalid band',
    (body) => {
      at(body.priorityBands, 1).startsAt = 1;
    },
    'invalid_body',
    'priorityBands[1].startsAt',
  ],
  [
    'nonpositive band start',
    (body) => {
      at(body.priorityBands).startsAt = 0;
    },
    'invalid_body',
    'priorityBands[0].startsAt',
  ],
  [
    'nonpositive band default',
    (body) => {
      at(body.priorityBands).defaultValue = 0;
    },
    'invalid_body',
    'priorityBands[0].defaultValue',
  ],
  [
    'band default outside its range',
    (body) => {
      at(body.priorityBands).defaultValue = 30;
    },
    'invalid_body',
    'priorityBands',
  ],
  [
    'invalid capacity',
    (body) => {
      at(body.capacity).size = 0;
    },
    'invalid_body',
    'capacity[0].size',
  ],
  [
    'duplicate capacity team',
    (body) => {
      body.capacity.push({ teamId: 'team-1', size: 1 });
    },
    'invalid_body',
    'capacity[1].teamId',
  ],
  [
    'unknown step',
    (body) => {
      at(body.workItems).estimates = { missing: { optimistic: 1, realistic: 1, pessimistic: 1 } };
    },
    'unknown_ref',
    'workItems[0].estimates.missing',
  ],
  [
    'unknown system',
    (body) => {
      at(at(body.workItems).externalRefs).systemId = 'missing';
    },
    'unknown_ref',
    'workItems[0].externalRefs[0].systemId',
  ],
  [
    'unknown person',
    (body) => {
      at(body.workItems).assignees['step-1'] = 'missing';
    },
    'unknown_ref',
    'workItems[0].assignees.step-1',
  ],
  [
    'unknown capacity team',
    (body) => {
      at(body.capacity).teamId = 'missing';
    },
    'unknown_ref',
    'capacity[0].teamId',
  ],
  [
    'unknown owned service',
    (body) => {
      const team = at(body.directory.teams);
      team.serviceIds = ['missing'];
    },
    'unknown_ref',
    'directory.teams[0].serviceIds[0]',
  ],
  [
    'unknown membership team',
    (body) => {
      const person = at(body.directory.people);
      person.teamIds = ['missing'];
    },
    'unknown_ref',
    'directory.people[0].teamIds[0]',
  ],
  [
    'unknown row tag',
    (body) => {
      at(body.workItems).tagIds = ['missing'];
    },
    'unknown_ref',
    'workItems[0].tagIds[0]',
  ],
  [
    'invalid row position',
    (body) => {
      at(body.workItems).position = 1.5;
    },
    'invalid_body',
    'workItems[0].position',
  ],
  [
    'blank row name',
    (body) => {
      at(body.workItems).name = '   ';
    },
    'invalid_body',
    'workItems[0].name',
  ],
  [
    'invalid parallelism',
    (body) => {
      at(body.workItems).maxParallel = 0;
    },
    'invalid_body',
    'workItems[0].maxParallel',
  ],
  [
    'empty external URL',
    (body) => {
      at(at(body.workItems).externalRefs).url = '';
    },
    'invalid_body',
    'workItems[0].externalRefs[0].url',
  ],
  [
    'overlong external ref name',
    (body) => {
      at(at(body.workItems).externalRefs).name = 'x'.repeat(301);
    },
    'invalid_body',
    'workItems[0].externalRefs[0].name',
  ],
  [
    'duplicate external ref id',
    (body) => {
      const row = at(body.workItems);
      row.externalRefs.push(structuredClone(at(row.externalRefs)));
    },
    'invalid_body',
    'workItems[0].externalRefs[1].id',
  ],
  [
    'unknown assignment step',
    (body) => {
      at(body.workItems).assignees = { missing: 'person-1' };
    },
    'unknown_ref',
    'workItems[0].assignees.missing',
  ],
];

test.each(fieldFaults)('%s refuses at the first stable path', (_name, fault, code, path) => {
  const body = planDocumentFixture();
  fault(body);
  expect(prepareImport(body, supportsAll)).toMatchObject({ ok: false, code, path });
});

const leafValueFaults: readonly (readonly [string, Fault, string])[] = [
  [
    'unordered estimate',
    (body) => {
      at(body.workItems).estimates = {
        'step-1': { optimistic: 3, realistic: 2, pessimistic: 1 },
      };
    },
    'workItems[0].estimates.step-1',
  ],
  [
    'negative actual',
    (body) => {
      at(body.workItems).actuals = { 'step-1': -1 };
    },
    'workItems[0].actuals.step-1',
  ],
  [
    'invalid progress',
    (body) => {
      at(body.workItems).progress = { 'step-1': 'not_started' };
    },
    'workItems[0].progress.step-1',
  ],
  [
    'unknown measure metric',
    (body) => {
      at(body.workItems).measures = { hours: { 'step-1': 1 } };
    },
    'workItems[0].measures.hours',
  ],
  [
    'negative measure',
    (body) => {
      at(body.workItems).measures = { hours_actual: { 'step-1': -1 } };
    },
    'workItems[0].measures.hours_actual.step-1',
  ],
  [
    'measure map is not an object',
    (body) => {
      at(body.workItems).measures = { hours_actual: 3 };
    },
    'workItems[0].measures.hours_actual',
  ],
];

test.each(leafValueFaults)('%s is refused as an invalid leaf value', (_name, fault, path) => {
  const body = planDocumentFixture();
  fault(body);
  expect(prepareImport(body, supportsAll)).toMatchObject({ ok: false, code: 'invalid_body', path });
});

test('validates step positions, marker colors and not-before reasons', () => {
  const duplicateStepPosition = planDocumentFixture();
  at(duplicateStepPosition.steps, 1).position = at(duplicateStepPosition.steps).position;
  expect(prepareImport(duplicateStepPosition, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'steps[1].position',
  });

  const malformedMarkerDate = planDocumentFixture();
  at(malformedMarkerDate.calendarMarkers).date = '2026-02-31';
  expect(prepareImport(malformedMarkerDate, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'calendarMarkers[0].date',
  });

  const blankMarkerName = planDocumentFixture();
  at(blankMarkerName.calendarMarkers).name = '';
  expect(prepareImport(blankMarkerName, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'calendarMarkers[0].name',
  });

  const malformedColor = planDocumentFixture();
  at(malformedColor.calendarMarkers).color = '#bad';
  expect(prepareImport(malformedColor, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'calendarMarkers[0].color',
  });

  const orphanedReason = planDocumentFixture();
  at(orphanedReason.workItems).startNoEarlierThan = null;
  expect(prepareImport(orphanedReason, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'workItems[0].startNoEarlierThanReason',
  });

  const overlongReason = planDocumentFixture();
  at(overlongReason.workItems).startNoEarlierThanReason = 'x'.repeat(201);
  expect(prepareImport(overlongReason, supportsAll)).toMatchObject({
    ok: false,
    code: 'invalid_body',
    path: 'workItems[0].startNoEarlierThanReason',
  });
});

test('accepts forward references and out-of-order parents', () => {
  const body = planDocumentFixture();
  const child = structuredClone(at(body.workItems));
  child.id = 'child';
  child.parentId = 'parent';
  child.dependsOn = ['later'];
  child.externalRefs = [];
  const parent = structuredClone(at(body.workItems));
  parent.id = 'parent';
  parent.parentId = null;
  parent.position = 20;
  parent.estimates = { broken: 'ignored parent aggregate' };
  parent.externalRefs = [];
  const later = structuredClone(at(body.workItems));
  later.id = 'later';
  later.position = 30;
  later.externalRefs = [];
  body.workItems = [child, parent, later];
  expect(prepareImport(body, supportsAll).ok).toBe(true);
});

const graphFaults: readonly (readonly [string, Fault, string, string])[] = [
  [
    'missing parent',
    (body) => {
      at(body.workItems).parentId = 'missing';
    },
    'unknown_ref',
    'workItems[0].parentId',
  ],
  [
    'parent self-cycle',
    (body) => {
      at(body.workItems).parentId = 'row-1';
    },
    'cycle',
    'workItems[0].parentId',
  ],
  [
    'duplicate sibling position',
    (body) => {
      const row = structuredClone(at(body.workItems));
      row.id = 'row-2';
      body.workItems.push(row);
    },
    'invalid_body',
    'workItems[1].position',
  ],
  [
    'unknown dependency',
    (body) => {
      at(body.workItems).dependsOn = ['missing'];
    },
    'unknown_ref',
    'workItems[0].dependsOn[0]',
  ],
];

test.each(graphFaults)('%s refuses before preparation', (_name, fault, code, path) => {
  const body = planDocumentFixture();
  fault(body);
  expect(prepareImport(body, supportsAll)).toMatchObject({ ok: false, code, path });
});

test('fully declared parent cycle refuses before admission', () => {
  const body = planDocumentFixture();
  const first = at(body.workItems);
  const second = structuredClone(first);
  second.id = 'row-2';
  second.position = 20;
  first.parentId = second.id;
  second.parentId = first.id;
  body.workItems.push(second);
  expect(prepareImport(body, supportsAll)).toMatchObject({
    ok: false,
    code: 'cycle',
    path: 'workItems[0].parentId',
  });
});

test('complete dependency rules refuse ancestry and cycles independent of edge order', () => {
  const ancestral = planDocumentFixture();
  const parent = at(ancestral.workItems);
  const child = structuredClone(parent);
  child.id = 'child';
  child.parentId = parent.id;
  child.position = 20;
  child.externalRefs = [];
  child.dependsOn = [parent.id];
  ancestral.workItems.push(child);
  expect(prepareImport(ancestral, supportsAll)).toMatchObject({
    ok: false,
    code: 'ancestor',
    path: 'workItems[1].dependsOn[0]',
  });

  const cyclic = planDocumentFixture();
  const first = at(cyclic.workItems);
  const second = structuredClone(first);
  second.id = 'row-2';
  second.position = 20;
  second.externalRefs = [];
  first.dependsOn = [second.id];
  second.dependsOn = [first.id];
  cyclic.workItems.push(second);
  expect(prepareImport(cyclic, supportsAll)).toMatchObject({
    ok: false,
    code: 'cycle',
    path: 'workItems[0].dependsOn[0]',
  });
});

test('parent aggregate maps never become prepared facts', () => {
  const body = planDocumentFixture();
  const parent = at(body.workItems);
  const child = structuredClone(parent);
  child.id = 'leaf';
  child.parentId = 'row-1';
  child.externalRefs = [];
  parent.estimates = { absent: 'deliberately invalid' };
  parent.actuals = { absent: -1 };
  parent.progress = { absent: 'blocked' };
  parent.measures = { made_up: { absent: -1 } };
  parent.assignees = {};
  Reflect.set(parent, 'doesEveryStep', true);
  body.workItems.push(child);
  const prepared = prepareImport(body, supportsAll);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.value.workItems[0]).toMatchObject({
    isLeaf: false,
    estimates: [],
    actuals: [],
    progress: [],
    measures: [],
    assignments: [],
  });
});

test('deadline before day zero is refused', () => {
  const body = planDocumentFixture();
  at(body.workItems).deadline = '2026-09-13';
  expect(prepareImport(body, supportsAll)).toMatchObject({
    ok: false,
    code: 'deadline_before_project_start',
    path: 'workItems[0].deadline',
  });
});

test('enabled unavailable optimizer refuses while a disabled preference is retained', () => {
  const unavailable = { supports: (engine: string) => engine === 'fast' };
  const enabled = planDocumentFixture();
  enabled.settings.optimizationEnabled = true;
  enabled.settings.scheduleEngine = 'optimized';
  expect(prepareImport(enabled, unavailable)).toMatchObject({
    ok: false,
    code: 'engine_unavailable',
    path: 'settings.scheduleEngine',
  });
  const disabled = planDocumentFixture();
  disabled.settings.scheduleEngine = 'optimized';
  const prepared = prepareImport(disabled, unavailable);
  expect(prepared.ok).toBe(true);
  if (prepared.ok) expect(prepared.value.settings.scheduleEngine).toBe('optimized');
});
