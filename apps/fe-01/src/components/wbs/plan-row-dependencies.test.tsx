import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';

import { shortIsoDate } from './short-date';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

// The table remembers each project's open branches and hidden columns in
// localStorage, so one test's shape would arrive as the next test's start.
beforeEach(() => {
  localStorage.clear();
});

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

const typeIntoDate = (label: string, day: string): void => {
  const box = screen.getByLabelText(label);
  fireEvent.change(box, { target: { value: day } });
  fireEvent.blur(box);
};

/** Every column on screen: the Teams cell is hidden by default. */
const showEveryColumn = (): void => {
  localStorage.setItem('wbs.hiddenColumns.p1', '[]');
};

/**
 * Two rows, a project start date, and a way to make a **peer's** edit land.
 *
 * The peer is the whole subject: a second person's write arrives as a socket
 * event, this client refetches, and every cell's committed reading is replaced
 * — while this reader is still half-way through typing somewhere else. That
 * pair of facts is one render, and task 2.2 has to keep it one after row
 * construction moves behind explicit render inputs.
 */
async function twoRowsAndAPeer() {
  const api = fakeApi();
  let notify: () => void = () => {
    throw new Error('the table never subscribed');
  };
  const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
    notify = handlers.onChange;
    return { seen: () => undefined, unsubscribe: () => undefined };
  };
  render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
  click('Add work item');
  await screen.findByLabelText('Name of 010');
  click('Add work item');
  await screen.findByLabelText('Name of 020');
  typeIntoDate('Project start date', '2026-08-06');
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 020').disabled).toBe(false);
  });
  const peer = api.rows.at(1);
  if (peer === undefined) throw new Error('the plan has no second row');
  return {
    api,
    peer,
    /** Somebody else's write, then the socket event this client hears. */
    peerWrites: async (write: () => void | Promise<void>): Promise<void> => {
      await write();
      await act(async () => {
        notify();
        await Promise.resolve();
      });
    },
  };
}

/**
 * Types into 010's Name and leaves the focus there, without leaving the box.
 *
 * The unrelated editor every case below carries. A name rather than a date or
 * an estimate because the Name cell is the one editor that is mounted on every
 * row at rest, so it is the only one that can stay open across a refetch that
 * replaces every other cell's reading.
 */
const halfTypeTheName = (typed: string): HTMLTextAreaElement => {
  const box = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
  box.focus();
  fireEvent.change(box, { target: { value: typed } });
  expect(document.activeElement).toBe(box);
  return box;
};

/** The half-typed editor, still open, still focused, still holding its text. */
const stillTyping = (box: HTMLTextAreaElement, typed: string): void => {
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe(typed);
};

/**
 * The peer-update and focus regressions R10 task 2.1 asks for, one per kind of
 * dependency in [the inventory](../../../../../openspec/changes/measured-rendering/row-dependency-inventory.md).
 *
 * Today every cell reads `live.current` and every render reaches every cell, so
 * these hold by construction. That is the point: they are written **before**
 * 2.2 replaces that with explicit render inputs, when "by construction" becomes
 * "by the dependency list somebody wrote down", and an omitted entry shows up
 * here as a stale figure rather than as a review comment.
 *
 * Each case asserts the peer's value **first** and the untouched editor second.
 * The other order passes vacuously: an assertion about a box nobody wrote to is
 * satisfied by the render before the answer arrives (`estimate-triple-visible`,
 * five of them in one change).
 */
describe('a peer’s edit and the editor that is open while it lands', () => {
  itDom('a committed name reaches the peer’s row', async () => {
    // Proof: `useTable`'s `data` handed a copy reused while the row count
    // holds — the shape a missed row dependency has, and one that leaves the
    // two-row setup working — this failed on `expected '' to be 'Renamed by a
    // peer'`. Watched 2026-09-08.
    const { peer, peerWrites } = await twoRowsAndAPeer();
    const typing = halfTypeTheName('Strip the old wir');

    await peerWrites(() => {
      peer.name = 'Renamed by a peer';
    });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 020').value).toBe(
        'Renamed by a peer',
      );
    });
    stillTyping(typing, 'Strip the old wir');
  });

  itDom('a committed day reaches the peer’s row on both of its read paths', async () => {
    // `startNoEarlierThan` is read twice per render on two independent paths —
    // the `<td>`'s own props (`plan-cell-props.ts`, outside the column
    // registry) and the cell body — so this case is the one that would catch
    // explicit render inputs feeding one of the two and not the other.
    //
    // Proof: the same reused-rows fault, failing on `expected '—' to be '9
    // Sep'`. Watched 2026-09-08.
    const { peer, peerWrites } = await twoRowsAndAPeer();
    const typing = halfTypeTheName('Strip the old wir');

    await peerWrites(() => {
      peer.startNoEarlierThan = '2026-09-09';
    });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Earliest start for 020').value).toBe(
        shortIsoDate('2026-09-09', new Date()),
      );
    });
    // The same day, through the other path: the cell's hover words are built
    // by the `<td>` props builder rather than by the column.
    expect(screen.getByLabelText('Earliest start for 020').getAttribute('data-fact')).toContain(
      '2026-09-09',
    );
    stillTyping(typing, 'Strip the old wir');
  });

  itDom('a committed estimate reaches the peer’s folded figure', async () => {
    // Proof: the same reused-rows fault, failing on `expected '' to be
    // '2/3/10'`. Watched 2026-09-08.
    const { peer, peerWrites } = await twoRowsAndAPeer();
    const typing = halfTypeTheName('Strip the old wir');

    await peerWrites(() => {
      peer.estimates['step-dev'] = { optimistic: 2, realistic: 3, pessimistic: 10 };
      peer.finalDays['step-dev'] = 4;
      peer.finalTotal = 4;
    });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Dev estimate for 020').value).toBe('2/3/10');
    });
    stillTyping(typing, 'Strip the old wir');
  });

  itDom('a committed schedule reading reaches the peer’s End cell', async () => {
    // Proof: caching each row's explicit `finish` by id — omitting its date
    // dependency while leaving the row mounted — failed below on `Expected
    // element to have text content: 10 Sep / Received: 0 ?`. Watched
    // 2026-09-08.
    showEveryColumn();
    const { api, peerWrites } = await twoRowsAndAPeer();
    const typing = halfTypeTheName('Strip the old wir');
    const peerRow = screen.getByLabelText('Name of 020').closest('tr');
    if (peerRow === null) throw new Error('row 020 has no table row');

    await peerWrites(() => api.setStartDate('p1', '2026-09-10'));

    await waitFor(() => {
      expect(peerRow.querySelector('[data-finish]')).toHaveTextContent(
        shortIsoDate('2026-09-10', new Date()),
      );
    });
    stillTyping(typing, 'Strip the old wir');
  });

  itDom('a directory entry a peer created reaches the peer’s row', async () => {
    // Two faults, because this cell reads two things: the row's own `teamIds`
    // and the directory the name comes out of. The reused-rows fault above and
    // `teams` pinned to the first render each failed it on `Unable to find
    // role="button" and name "Remove Platform team"`. Both watched 2026-09-08.
    showEveryColumn();
    const { api, peer, peerWrites } = await twoRowsAndAPeer();
    const typing = halfTypeTheName('Strip the old wir');

    await peerWrites(async () => {
      await api.addTeam('Platform');
      peer.teamIds = ['team1'];
      peer.serviceTeamId = null;
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove Platform team' })).toBeInTheDocument();
    });
    stillTyping(typing, 'Strip the old wir');
  });
});
