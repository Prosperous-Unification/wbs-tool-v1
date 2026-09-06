import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeProjectApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import { MONDAY_START, planOf, pointedAtRow, rowAt, sliceAt } from './gantt-fixtures';
import { GanttPanel } from './gantt-panel';

/**
 * Slice 4.3a — **no instant is converted on the client**, watched from the
 * only tier that can watch it.
 *
 * A calendar day on this product is a `YYYY-MM-DD` with no zone, and the client
 * is the only layer that could turn one into an instant: 4.3 already refuses a
 * timestamp at be-01's boundary, so nothing that got through here could enter
 * storage as a date at all. The fault is `new Date(day + 'T00:00:00')` —
 * **local** midnight — anywhere between the axis cell and the outgoing create
 * body.
 *
 * It lives in its own file because that fault is invisible under the `TZ=UTC`
 * the `test` target pins: local midnight *is* UTC midnight there, so the round
 * trip returns the very day it was given and the negative would be green with
 * the fault in. `vitest.zoned.config.ts` runs this file under
 * `TZ=Pacific/Auckland`, where `2026-08-19T00:00:00` is `2026-08-18` in UTC —
 * measured on the gate host 2026-09-05, both arms. That the runner really
 * started under that zone is asserted once, in
 * `src/zoned-runner.zoned.test.ts`, and not repeated here.
 */

/** fnv1a32 mod 8 → 1, amber. A UUID v4, because 4.6a's route refuses anything else. */
const MARKER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * Offset 9 on a plan starting Monday 2026-08-10 — the Wednesday of the second
 * week, `2026-08-19`, carrying no marker so that a click opens the composer
 * rather than the day sheet.
 */
const GO_LIVE_DAY = '2026-08-19';

afterEach(cleanup);

describe('a clicked day reaches the create body as the day it was, under a non-UTC runner', () => {
  const cellAt = (offset: number): Element => {
    const cell = document.querySelector(`[data-axis-day="${String(offset)}"]`);
    if (cell === null) throw new Error(`no axis cell at offset ${String(offset)}`);
    return cell;
  };

  it('sends the clicked date verbatim rather than its UTC neighbour', async () => {
    const api = fakeProjectApi();
    const creates = recordCalls(api, 'createCalendarMarker');
    render(
      <GanttPanel
        plan={planOf({
          rows: [rowAt('strip', 0, 10)],
          slices: [sliceAt('strip-dev', 'strip', 0, 10)],
        })}
        startDate={MONDAY_START}
        scheduleError={null}
        generation={0}
        heightPx={null}
        onPickRow={() => undefined}
        onPointRow={() => undefined}
        pointed={pointedAtRow(null)}
        markers={[]}
        newMarkerId={() => MARKER_ID}
        onCreateMarker={(marker) => {
          void api.createCalendarMarker('p1', marker);
        }}
      />,
    );

    // The axis itself first: it is built on the client from `startDate` and an
    // offset, so a `Date` round trip in *that* arithmetic is the same fault one
    // step earlier, and this line is where it would surface.
    expect(cellAt(9).getAttribute('data-axis-date')).toBe(GO_LIVE_DAY);

    fireEvent.click(cellAt(9));

    // Matched by pattern, not by the exact `19 Aug` the correct run renders.
    // The button's name is derived from the composer's own date, so under the
    // fault it reads `18 Aug` and an exact query would throw "unable to find an
    // element" — the case has to fail on the request it is about, not on a
    // missing button.
    fireEvent.click(screen.getByRole('button', { name: /^Save the new calendar marker on / }));

    // The whole body, exactly: this is the assertion 4.3a is, and the id and
    // the name are pinned so that it can only fail for the date.
    await waitFor(() => {
      expect(creates).toEqual([['p1', { markerId: MARKER_ID, date: GO_LIVE_DAY, name: '' }]]);
    });
    // And the fake really holds that day, which a recorder that logged without
    // performing would not show.
    expect(api.markers.map((marker) => marker.date)).toEqual([GO_LIVE_DAY]);
  });
});
