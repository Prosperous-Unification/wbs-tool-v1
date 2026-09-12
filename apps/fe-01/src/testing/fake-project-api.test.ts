import { automaticColor } from '@wbs/domain/marker-color';
import { describe, expect, it } from 'vitest';

import { fakeProjectApi } from './fake-project-api';

/**
 * The double's marker answers, held to the shape the real route can produce.
 *
 * `calendar-marker.routes.ts` resolves the automatic colour in `answered()` on
 * the way out, so `color: null` is a request and never a response. The client
 * used to carry its own `?? automaticColor(id)` beside that (task 284), which
 * meant a fixture answering `null` still drew — the duplicate silently covered
 * for a double laxer than the API. With the duplicate gone the only thing
 * standing between "the fake answers null" and a marker drawn with no fill is
 * this file, so the invariant is asserted here rather than left to the
 * chart's own cases.
 */
describe('the fake answers markers the way be-01 does', () => {
  it('answers a marker created automatic with the resolved colour, never null', async () => {
    // The negative this is for: `color: marker.color ?? null` in
    // `fake-project-api.ts` — the line this task removed. Restore it and this
    // case fails on `expected null to be '#…'`, which is the whole point:
    // without it, a fixture answering a shape be-01 cannot send passes every
    // chart test and only production has no fallback left to survive it.
    const api = fakeProjectApi();

    const created = await api.createCalendarMarker('p1', {
      markerId: 'm-auto',
      date: '2026-08-19',
      name: 'Freeze',
      color: null,
    });

    expect(created.color).toBe(automaticColor('m-auto'));
  });

  it('answers the same resolved colour on the list read the panel draws from', async () => {
    // The create answer and the list answer are two code paths onto one store,
    // and the chart reads the second. A create that resolved while the list
    // handed back what was stored would leave exactly one drawn mark unfilled.
    const api = fakeProjectApi();
    await api.createCalendarMarker('p1', {
      markerId: 'm-auto',
      date: '2026-08-19',
      name: 'Freeze',
      color: null,
    });
    await api.createCalendarMarker('p1', {
      markerId: 'm-cut',
      date: '2026-08-20',
      name: 'Cutover',
      color: '#0386a5',
    });

    const listed = await api.listCalendarMarkers('p1');

    expect(listed.map((marker) => marker.color)).toEqual([automaticColor('m-auto'), '#0386a5']);
    // Stated as its own assertion and not folded into the pair above: the pair
    // would still pass if a later resolution answered `''`, and an empty fill
    // is the failure this task exists to make impossible.
    for (const marker of listed) expect(marker.color).not.toBe('');
  });

  it('resolves a recolour back to automatic, which is the one write that sends null', async () => {
    // `recolorCalendarMarker(…, null)` is the reader handing a marker back to
    // the automatic colour: `null` on the wire in, resolved colour in the
    // answer. The fake keeping the `null` it was handed is the same laxness in
    // the one place a test could still introduce it after the create path was
    // fixed.
    const api = fakeProjectApi();
    await api.createCalendarMarker('p1', {
      markerId: 'm-cut',
      date: '2026-08-19',
      name: 'Cutover',
      color: '#0386a5',
    });

    const recoloured = await api.recolorCalendarMarker('p1', 'm-cut', null);

    expect(recoloured.color).toBe(automaticColor('m-cut'));
    expect(api.markers.map((marker) => marker.color)).toEqual([automaticColor('m-cut')]);
  });
});

describe('the fake uses the shared tree response shape', () => {
  it('validates the read before handing it to a screen', async () => {
    const api = fakeProjectApi();
    const made = await api.createWorkItem('p1', {
      parentId: null,
      afterId: null,
      name: 'Wire it',
    });

    const plan = await api.tree('p1');

    expect(plan.workItems.find((row) => row.id === made.id)).toMatchObject({
      name: 'Wire it',
      tagIds: [],
      serviceIds: [],
      typeIds: [],
      externalRefs: [],
    });
  });

  it('validates a mutation before changing the in-memory project', async () => {
    const api = fakeProjectApi();

    await expect(api.addStep('p1', 7 as never)).rejects.toThrow('fake_invalid_request');

    expect(await api.steps('p1')).toEqual([
      { id: 'step-dev', name: 'Dev' },
      { id: 'step-qa', name: 'QA' },
    ]);
  });

  it('validates a modeled refusal before handing it to a screen', async () => {
    const api = fakeProjectApi();
    const made = await api.createWorkItem('p1', {
      parentId: null,
      name: 'Estimated work',
    });
    await api.setEstimate(made.id, 'step-dev', {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });

    await expect(api.removeStep('p1', 'step-dev', false)).resolves.toMatchObject({
      ok: false,
      reason: 'in_use',
      inUse: { estimates: 1 },
    });
  });
});

describe('the fake arranges a plan the way be-01 does', () => {
  it('puts the work item that starts first at the top, and keeps a tie in place', async () => {
    const api = fakeProjectApi();
    const strip = await api.createWorkItem('p1', { parentId: null, name: 'Strip' });
    const sand = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Sand',
    });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: sand.id,
      name: 'Paint',
    });
    // An estimate on `Paint`, because this fake gives an unestimated row a
    // duration of zero — the real engine assumes two workdays — and a
    // predecessor that takes no time moves nothing.
    await api.setEstimate(paint.id, 'step-dev', { optimistic: 1, realistic: 2, pessimistic: 3 });
    // `Strip` waits for `Paint`, so `Sand` and `Paint` both begin on day zero
    // and keep the order they already read in.
    await api.addDependency(strip.id, paint.id);

    await api.arrangeBySchedule('p1');

    const tree = await api.tree('p1');
    expect(tree.workItems.map((row) => row.name)).toEqual(['Sand', 'Paint', 'Strip']);
  });

  it('leaves a frozen number alone while the work item moves', async () => {
    const api = fakeProjectApi();
    const strip = await api.createWorkItem('p1', { parentId: null, name: 'Strip' });
    const paint = await api.createWorkItem('p1', {
      parentId: null,
      afterId: strip.id,
      name: 'Paint',
    });
    await api.setEstimate(paint.id, 'step-dev', { optimistic: 1, realistic: 2, pessimistic: 3 });
    await api.addDependency(strip.id, paint.id);
    await api.freezeProject('p1');

    await api.arrangeBySchedule('p1');

    const tree = await api.tree('p1');
    expect(tree.workItems.map((row) => [row.name, row.number])).toEqual([
      ['Paint', '020'],
      ['Strip', '010'],
    ]);
  });
});
