import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItemView } from '@/lib/wbs-api';
import { fakeProjectApi as fakeApi } from '@/testing/fake-project-api';
import { recordCalls } from '@/testing/record-calls';

import { refusedDraftFor } from './live-editing';
import type * as TableFrameModule from './table-frame';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';

const itDom = hasDom ? it : it.skip;

/**
 * How many `<td>`/`<th>` renders the table has performed, counted through
 * {@link flexibleCellStyle} — every body cell and heading computes its flexible
 * width exactly once per render (wbs-table.tsx's `<td>`/`<th>` style spreads),
 * so the count divided by the column count is "how many rows rendered".
 *
 * The pointed-row probes read this to assert render isolation: pointing a row
 * must re-render the rows whose light changed and nothing else. jsdom can see
 * nothing else that distinguishes "memo held" from "memo silently vacuous" —
 * React reuses the DOM nodes either way.
 *
 * The mock is call-through: every other test sees the real module unchanged.
 */
const cellStyleCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./table-frame', async (importOriginal) => {
  const real = await importOriginal<typeof TableFrameModule>();
  return {
    ...real,
    flexibleCellStyle: (...args: Parameters<typeof real.flexibleCellStyle>) => {
      cellStyleCalls.count += 1;
      return real.flexibleCellStyle(...args);
    },
  };
});

const numbersOnScreen = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('[data-number]')?.textContent ?? '');

/** What the toast stack is saying, newest first. */
const toastTexts = (): string[] =>
  [...document.querySelectorAll('[data-toast-text]')].map((node) => node.textContent);

/** The stale-tree banner, or null while the tree on screen is believed current. */
const staleBanner = (): Element | null => document.querySelector('[data-stale-tree]');

const click = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

/** Opens one row's ⋯ menu, the way a pointer does. */
const openRowMenu = (number: string) => {
  click(`Actions for ${number}`);
};

/**
 * Opens the toolbar's `Freeze #` menu and takes one of its two items.
 *
 * `Freeze numbering` and `Unfreeze all` were two buttons on the bar until
 * `plan-toolbar-controls`; they are the items of one menu now, so every case
 * that took either of them opens the menu first. Each such case is listed
 * individually in that change's `verify.md` — a test that changed shape is a
 * place the "same behaviour" claim is asserted rather than observed.
 *
 * The item names are unqualified, which is only unambiguous because a row's ⋯
 * calls its own item `Unfreeze` rather than `Unfreeze all`.
 */
const takeFreezeAction = (label: string) => {
  click('Freeze #');
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};

/**
 * Opens a row's ⋯ menu and takes one of its items.
 *
 * The items are named plainly — `Duplicate`, not `Duplicate 010` — which is
 * only unambiguous because one menu is open at a time. That rule is the subject
 * of `opening one row’s menu closes the one already open`; if it broke, every
 * use of this helper would fail on two elements with the same name.
 */
const takeRowAction = (number: string, label: string) => {
  openRowMenu(number);
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};

const typeName = (number: string, value: string) => {
  fireEvent.change(screen.getByLabelText(`Name of ${number}`), { target: { value } });
};

/**
 * Ctrl+N in a named row's Name cell: a new work item below it.
 *
 * Keys are fired at a named row rather than at `document.activeElement`.
 * Focus is a real behaviour and gets its own assertion, but using it to steer
 * these tests would make every one of them fail for the same reason if focus
 * broke — and none of them would say which behaviour was actually wrong.
 *
 * This was `pressEnter` until `command-keys`. Enter in a name is now the
 * browser's own newline — a work item's notes are written under its name in
 * that box — and the tests that only ever used Enter as scaffolding to *get* a
 * second row moved to the chord that makes one. What Enter does instead has
 * its own tests in `the command chords`.
 */
const pressNewItem = (number: string) => {
  fireEvent.keyDown(screen.getByLabelText(`Name of ${number}`), {
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
  });
};

/**
 * Opens a step's folded columns — the trio and the assignee. Folded is the
 * default, so every test that types an estimate or assigns someone does this
 * first, exactly as a person would.
 */
const unfoldStep = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Unfold ${name} estimates` }));
};

// The table remembers each project's open branches in localStorage, so one
// test's collapsing would arrive as the next test's starting shape.
beforeEach(() => {
  localStorage.clear();
});

/** Three named root rows: `010 Strip`, `020 Sand`, `030 Paint`. */
async function threeRoots() {
  // Dev's columns take part in the keyboard grid below, so they are open.

  const api = fakeApi();
  render(<WbsTable projectId="p1" api={api} />);
  // Named, not left blank. Blank names made an ordering assertion compare three
  // empty strings against three empty strings, which passes for any order.
  for (const [number, name] of [
    ['010', 'Strip'],
    ['020', 'Sand'],
    ['030', 'Paint'],
  ]) {
    click('Add work item');
    await screen.findByLabelText(`Name of ${number}`);
    typeName(number, name);
    fireEvent.blur(screen.getByLabelText(`Name of ${number}`));
    await waitFor(() => {
      expect(screen.getByLabelText(`Name of ${number}`)).toHaveProperty('value', name);
    });
  }
  unfoldStep('Dev');
  return api;
}

describe('live edits from other people', () => {
  itDom('focuses a newly created row so the next keystroke lands in it', async () => {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);

    click('Add work item');
    const first = await screen.findByLabelText('Name of 010');
    pressNewItem('010');

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name of 020'));
    });
    expect(document.activeElement).not.toBe(first);
  });

  itDom('refetches when the subscription reports a change', async () => {
    const api = fakeApi();
    // Throws rather than doing nothing: if the component never subscribes, this
    // test should fail loudly instead of quietly asserting a tree that never
    // needed refreshing.
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    let unsubscribed = false;
    const seen: number[] = [];
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return {
        seen: (seq: number) => seen.push(seq),
        unsubscribe: () => {
          unsubscribed = true;
        },
      };
    };

    const view = render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });

    // Somebody else's edit, arriving through the socket rather than this client.
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Theirs' });
    notify();

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010']);
    });

    // The stream resumes from what the table read, so every read must report
    // where it landed — otherwise the next reconnect asks for a range that
    // starts before the rows already on screen.
    expect(seen.at(-1)).toBe(api.rows.length - 1);

    view.unmount();
    expect(unsubscribed).toBe(true);
  });

  /**
   * Every read one refresh makes, in the order `refresh` issues them.
   *
   * Named here rather than inline so a read added to `refresh` and forgotten
   * here shows up as a count these cases disagree with, rather than as one they
   * silently stop counting.
   */
  const READS_ONE_REFRESH_MAKES = [
    'tree',
    'steps',
    'listTeams',
    'listTags',
    'listServices',
    'listWorkItemTypes',
    'listExternalSystems',
    'listPeople',
  ] as const;

  /**
   * Counts the requests one read makes, by path.
   *
   * Wraps the fake rather than changing it: every other test in the repository
   * sees `fakeProjectApi` exactly as it was, and the counters are this block's.
   */
  const countingApi = () => {
    const api = fakeApi();
    // One array across the eight reads, because what these cases are about is
    // **how many** of them a frame or a write starts — a per-method array
    // cannot tell "one read" from "eight". The projections do the recording;
    // the arrays `recordCalls` hands back are not read.
    const reads: string[] = [];
    for (const method of READS_ONE_REFRESH_MAKES) {
      recordCalls(api, method, () => reads.push(method));
    }
    return { api, reads };
  };

  /** Mounts, waits for the first read to land, then forgets what it cost. */
  const mountedAndCounted = async () => {
    const { api, reads } = countingApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(reads).toContain('listPeople');
    });
    reads.length = 0;
    return {
      notify: (changed?: string | null) => {
        notify(changed);
      },
      reads,
    };
  };

  itDom('a tree_replaced frame reads the tree and nothing else', async () => {
    const { notify, reads } = await mountedAndCounted();

    // What be-01 sends when somebody else's edit replaced the rows. The six
    // global vocabularies cannot have changed behind it: a plan batch that
    // mints a person or a tag holds the directory announcement and sends it
    // after the commit, so a directory change arrives as its own frame.
    notify('tree_replaced');

    await waitFor(() => {
      expect(reads).toContain('tree');
    });
    expect(reads).toEqual(['tree']);
  });

  itDom('a step frame reads the tree and the steps, and no vocabulary', async () => {
    const { notify, reads } = await mountedAndCounted();

    notify('step_renamed');

    await waitFor(() => {
      expect(reads).toContain('steps');
    });
    expect([...reads].sort()).toEqual(['steps', 'tree']);
  });

  itDom('a directory_changed frame still reads every list', async () => {
    const { notify, reads } = await mountedAndCounted();

    // Not narrowed, and this is the case that says why: a removed team takes
    // its assignments and its labels out of the tree with it, so the tree alone
    // would leave a picker offering a team that no longer exists.
    notify('directory_changed');

    await waitFor(() => {
      expect(reads).toContain('listPeople');
    });
    expect([...reads].sort()).toEqual([
      'listExternalSystems',
      'listPeople',
      'listServices',
      'listTags',
      'listTeams',
      'listWorkItemTypes',
      'steps',
      'tree',
    ]);
  });

  itDom('a frame this build cannot read reads every list', async () => {
    const { notify, reads } = await mountedAndCounted();

    // R5: unknown is not OK. An event kind added to be-01 after this build, and
    // a frame whose `message` this side could not read at all, are the same
    // thing here — neither is a licence to skip a read.
    notify('a_kind_from_a_later_be_01');
    await waitFor(() => {
      expect(reads).toContain('listPeople');
    });
    expect(reads).toHaveLength(8);

    reads.length = 0;
    notify(null);
    await waitFor(() => {
      expect(reads).toContain('listPeople');
    });
    expect(reads).toHaveLength(8);
  });

  itDom('says so while the connection is down', async () => {
    // A table that looks identical whether or not it is live is the failure this
    // is here to remove: other people's edits stop arriving silently.
    const api = fakeApi();
    let report: (connected: boolean) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      report = handlers.onConnectionChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };

    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });
    expect(screen.queryByRole('status')).toBeNull();

    act(() => {
      report(false);
    });
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');

    act(() => {
      report(true);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('someone else editing while you are typing', () => {
  itDom('does not take the focus or the half-typed value', async () => {
    // Two reviewers found this and neither was looking for it. `onKeyDown`
    // reaches `flat` through `indent`/`outdent`, and `flat` is rebuilt by every
    // refresh — so `columns` was a new array on every socket event, `flexRender`
    // gave every cell a new component type, and React unmounted and remounted
    // the lot. The comment above the dependency list had been warning about
    // exactly this while the list itself caused it.
    const api = fakeApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });
    expect(document.activeElement).toBe(input);

    // Somebody else's edit lands mid-word.
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(screen.getByLabelText('Name of 010'));
    expect(screen.getByLabelText('Name of 010')).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('survives their edit landing in the very field being typed in', async () => {
    // The test above only ever delivered an edit that left this row's name
    // alone, so it passed while `key={`${id}-${name}`}` was still on the input:
    // an unchanged name is an unchanged key. Changing the name is the case that
    // remounted the node and dropped the focus to the body, and it is the one
    // that happens whenever two people work on one row.
    // Proof: `key` restored on the name input in `wbs-table.tsx` and only this
    // test failed — `document.activeElement` was `<body>` and the value was the
    // peer's, not the half-typed one.
    const api = fakeApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    input.focus();
    fireEvent.change(input, { target: { value: 'Strip the old wir' } });

    // Their edit, to this row's name — the value this cell renders from.
    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value', 'Strip the old wir');
  });

  itDom('shows their edit in a cell nobody is typing in', async () => {
    // The other half of the rule, and the reason it is a separate test: a cell
    // that simply never accepted a new value would pass both tests above.
    // Proof: the `input.value = latest.current` assignment in `cell-input.tsx`
    // deleted, and only this test failed — the cell still read 'Strip'.
    const api = fakeApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    fireEvent.change(input, { target: { value: 'Strip' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(input).toHaveProperty('value', 'Strip');
    });

    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Name of 010')).toBe(input);
    expect(input).toHaveProperty('value', 'Rewire the shed');
  });

  itDom('sends nothing when a cell is left without being typed in', async () => {
    // Every blur used to be a PATCH of whatever the box held, so clicking
    // through a row wrote every cell it passed. Each of those writes is a
    // broadcast and a refetch for everyone else, and one of them is a revert: a
    // cell whose peer edit was held back while its owner was typing, then typed
    // back to what it said before, blurs holding the older of the two values.
    // Proof: `input.value !== shown.current` in `cell-input.tsx`'s `onBlur`
    // replaced with `true`, and only this test failed — one patch of a name
    // nobody typed.
    const api = fakeApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const input = await screen.findByLabelText('Name of 010');
    fireEvent.change(input, { target: { value: 'Strip' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(api.rows[0].name).toBe('Strip');
    });

    const patched: unknown[] = [];
    api.patchWorkItem = (...args: unknown[]) => {
      patched.push(args);
      return Promise.resolve();
    };

    // Their edit lands, then this client focuses the cell and leaves it again
    // without typing.
    api.rows[0].name = 'Rewire the shed';
    await act(async () => {
      notify();
      await Promise.resolve();
    });
    input.focus();
    fireEvent.blur(input);

    expect(patched).toEqual([]);
    expect(input).toHaveProperty('value', 'Rewire the shed');
  });

  /**
   * One row with a name and a note, a live subscription, and the two handles a
   * peer-collision test needs: what be-01 was asked for, and the peer's own
   * arrival.
   *
   * The whole point is that this goes through the real render path — the peer's
   * edit reaches the cell as new props from a refetch, exactly as it does in
   * the app, and `CellInput`'s rule 2 holds it back because this client is
   * mid-word. A test that reached into the component would prove nothing about
   * the arrival that causes the bug.
   */
  async function peerAndMe(name: string, notes: string) {
    const api = fakeApi();
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);

    click('Add work item');
    const cell = await screen.findByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(cell, { target: { value: `${name}\n${notes}` } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(api.rows[0]?.notes).toBe(notes);
    });

    const patched = recordCalls(api, 'patchWorkItem');
    /** Their edit, landing while this client is mid-word. */
    const theirEdit = async (change: (row: WorkItemView) => void) => {
      change(api.rows[0]);
      await act(async () => {
        notify();
        await Promise.resolve();
      });
    };
    return { api, patched, cell, theirEdit };
  }

  itDom('keeps a peer’s note when the name is what was being typed', async () => {
    // codex #3 and agy #3, from opposite ends of the same hole. The commit is
    // diffed against what this box was showing when the typing began, never
    // against the row it renders from: their note arrived mid-word and was
    // held back, so this client's blur has no idea it exists — and must not
    // therefore send `notes: ''` over the top of it.
    //
    // Proof: `was` in `commitNameCell` re-pointed at the current row props,
    // `splitNameCell(composeNameCell(here.name, here.notes))` off `flat`. This
    // failed on `expected 'measure twice' to be 'their note'` — their note
    // replaced with the stale one this client had on screen, by somebody who
    // never saw theirs. Watched, 2026-08-08.
    const { api, patched, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the old wir\nmeasure twice' } });
    await theirEdit((row) => {
      row.notes = 'their note';
    });
    // Held back rather than shown: this client is mid-word in the box their
    // edit landed in, which is the collision that makes the diff hard.
    expect(cell.value).toBe('Strip the old wir\nmeasure twice');

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    // Their note first, because it is the harm: the request shape below is how
    // it is avoided, and a test that only asserted the shape would report a
    // clobber as a disagreement about JSON.
    expect(api.rows[0]?.notes).toBe('their note');
    expect(patched).toEqual([['w1', { name: 'Strip the old wir' }]]);
    expect(api.rows[0]?.name).toBe('Strip the old wir');
  });

  itDom('keeps a peer’s name when the notes are what was being typed', async () => {
    // The mirror of it, and a separate test for the reason the pair above is:
    // a diff that got one direction right by accident would pass the other.
    //
    // Proof: the same fault. This failed on `expected 'Strip' to be 'Rewire
    // the shed'` — their rename written over by somebody who was typing a
    // note. Watched, 2026-08-08.
    const { api, patched, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip\nmeasure twice, cut once' } });
    await theirEdit((row) => {
      row.name = 'Rewire the shed';
    });
    expect(cell.value).toBe('Strip\nmeasure twice, cut once');

    fireEvent.blur(cell);
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });

    expect(api.rows[0]?.name).toBe('Rewire the shed');
    expect(patched).toEqual([['w1', { notes: 'measure twice, cut once' }]]);
    expect(api.rows[0]?.notes).toBe('measure twice, cut once');
  });

  itDom('keeps a refused draft on screen when the next refetch arrives', async () => {
    // codex round 1, finding 1. A refusal leaves the typed text in the box and
    // nowhere else: be-01 has not got it, and the row this cell renders from
    // still says what it always said. The next refetch — anybody's edit, this
    // client's own next request, a reconnect — carries a value that differs
    // from what the box was last showing, and rule 1 would write it in over
    // two fields the person typed and was never told were lost.
    //
    // Proof: the `refused.current` gate deleted from `sync`, this failed on
    // `expected 'Rewire the shed\nmeasure twice' to be 'Strip the wiring\n
    // measure twice, cut …'` — both typed fields replaced by the server's,
    // silently. Watched, 2026-08-08.
    const { api, cell, theirEdit } = await peerAndMe('Strip', 'measure twice');
    // Refused for a reason retyping cannot fix, so what is in the box is all
    // there is of this edit anywhere.
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    cell.focus();
    fireEvent.change(cell, { target: { value: 'Strip the wiring\nmeasure twice, cut once' } });
    fireEvent.blur(cell);
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    await theirEdit((row) => {
      row.name = 'Rewire the shed';
    });

    expect(cell.value).toBe('Strip the wiring\nmeasure twice, cut once');
  });
});

describe('failures you can see', () => {
  /** Types a dependency list into a row's cell and sends it. */
  const typeDeps = (rowNumber: string, value: string) => {
    const input = screen.getByLabelText(`Add a dependency to ${rowNumber}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  /** A table subscribed to a socket, with the handle that fires a change event. */
  async function subscribedTable() {
    const api = fakeApi();
    // Throws rather than doing nothing: a table that never subscribed must
    // fail loudly here instead of quietly asserting a tree nothing refreshed.
    let notify: (changed?: string | null) => void = () => {
      throw new Error('the table never subscribed');
    };
    const subscribe = (_projectId: string, handlers: SubscriptionHandlers) => {
      notify = handlers.onChange;
      return { seen: () => undefined, unsubscribe: () => undefined };
    };
    render(<WbsTable projectId="p1" api={api} subscribe={subscribe} />);
    await api.createWorkItem('p1', { parentId: null, afterId: null, name: 'Strip' });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
    return {
      api,
      notify: () => {
        notify();
      },
    };
  }

  itDom('says a refused rename in a toast, and puts nothing above the table', async () => {
    const api = await threeRoots();
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    await waitFor(() => {
      expect(toastTexts()).toEqual([
        'That change could not be completed: this plan is not yours to change.',
      ]);
    });
    // The single alert on screen is the toast itself. The top-of-page error
    // line is gone: two alerts here would be the old one still rendering.
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest('[data-toasts]')).not.toBeNull();
  });

  itDom('keeps a failure on screen when the next action succeeds', async () => {
    // `run` used to clear the error line before every request, so the reason a
    // rename was refused disappeared the moment anything else worked. A toast
    // owns its own lifecycle: only its ✕ takes it off.
    const api = await threeRoots();
    const realPatch = api.patchWorkItem.bind(api);
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        'That change could not be completed: this plan is not yours to change.',
      ]);
    });

    api.patchWorkItem = realPatch;
    typeName('020', 'Sanded');
    fireEvent.blur(screen.getByLabelText('Name of 020'));
    await waitFor(() => {
      expect(screen.getByLabelText('Name of 020')).toHaveProperty('value', 'Sanded');
    });

    expect(toastTexts()).toEqual([
      'That change could not be completed: this plan is not yours to change.',
    ]);
  });

  itDom('takes a failure off when its ✕ is pressed', async () => {
    const api = await threeRoots();
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));
    await waitFor(() => {
      expect(toastTexts()).toHaveLength(1);
    });

    click('Dismiss: That change could not be completed: this plan is not yours to change.');

    expect(toastTexts()).toEqual([]);
  });

  itDom('says a row that has gone is gone, and rereads the tree that proves it', async () => {
    // The race a real user hits: somebody else deletes the row first, and this
    // client's delete comes back `not_found`. The word itself reached the
    // corner of the screen as `not_found` until 2026-08-09 — and the row it
    // was about stayed on screen, because `run` skips the reread after a
    // refusal. Both halves are the fix.
    //
    // Proof, two faults, both watched 2026-08-09. The mapping removed so the
    // code is passed through, this failed on `expected [ 'not_found' ] to
    // include 'That change could not be completed: its target is no longer
    // here — someone may have deleted it.'`. The reread removed, it failed on
    // `expected [ '010', '020', '030' ] to deeply equal [ '010', '020' ]` — a
    // sentence saying a row is gone above the row, still there.
    const api = await threeRoots();
    const realRemove = api.removeWorkItem.bind(api);
    api.removeWorkItem = async (id: string) => {
      // The peer's delete, renumbering and all, and then be-01's answer to
      // ours: there is no such row any more.
      await realRemove(id);
      throw new Error('not_found');
    };

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: its target is no longer here — someone may have deleted it.',
      );
    });
    await waitFor(() => {
      expect(numbersOnScreen()).toEqual(['010', '020']);
    });
  });

  itDom('says the server could not do it rather than showing a status', async () => {
    // `http_500` is what `send` throws when be-01 answers with one and the body
    // carries no word of its own. It was the toast, verbatim, until 2026-08-09.
    // Not "the server did not answer": something answered, with a 500.
    // Proof: the 5xx branch removed, this failed on `expected [ 'http_500' ] to
    // include 'The server could not complete that change. Try again.'`.
    // Watched, 2026-08-09.
    const api = await threeRoots();
    api.removeWorkItem = () => Promise.reject(new Error('http_500'));

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain('The server could not complete that change. Try again.');
    });
    // A 500 is not a "gone": nothing is reread and nothing leaves the screen.
    expect(numbersOnScreen()).toEqual(['010', '020', '030']);
  });

  itDom('turns a validation refusal into a sentence, and rereads the plan', async () => {
    // `http_422` is what `send` throws when be-01 refuses the *body* — an
    // ArkType failure carries Elysia's own JSON, with no word for `send` to
    // read. It reached the corner of the screen verbatim on 2026-08-09, to
    // somebody who had done nothing more exotic than type a date.
    // Proof: the `INVALID_REQUEST` branch removed from `refusalSentence`, this
    // failed on `expected [ Array(1) ] to include 'That change was not valid,
    // so nothing…'`; and the `INVALID_REQUEST` half of the reread condition
    // removed, it failed on `expected +0 to be 1`. Both watched, 2026-08-09.
    const api = await threeRoots();
    // A count rather than a `recordCalls` array, and deliberately: the proof
    // above quotes `expected +0 to be 1`, and this is one number rather than
    // one of the forty-five recorders.
    let reads = 0;
    const realTree = api.tree.bind(api);
    api.tree = (projectId: string) => {
      reads += 1;
      return realTree(projectId);
    };
    api.patchWorkItem = () => Promise.reject(new Error('http_422'));

    fireEvent.change(screen.getByLabelText('Name of 020'), { target: { value: 'Sand it' } });
    fireEvent.blur(screen.getByLabelText('Name of 020'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change was not valid, so nothing was saved — what is on screen was read again.',
      );
    });
    // No status code anywhere in what the reader is shown.
    expect(toastTexts().join(' ')).not.toContain('http_422');
    // And the plan really was read again, which is what the sentence claims:
    // `run` skips the reread after a refusal, so this only happens for the
    // refusals that say the screen is behind.
    await waitFor(() => {
      expect(reads).toBe(1);
    });
  });

  itDom('turns be-01’s own word for an unreadable body into the same sentence', async () => {
    // The sibling above covers `http_422`, which is what `send` throws when the
    // 422 carries no `error` field. That was every schema refusal until the
    // controllers stopped declaring schemas to Elysia: they now check their own
    // bodies and answer `{ error: 'invalid_body' }`, so `send` has a word to
    // read and throws it instead of the status.
    //
    // Reachable, and measured on this branch rather than assumed:
    // `wbs-table.tsx` sends the plan's start date through `run` →
    // `api.setStartDate` → `PATCH /api/projects/:id`, whose `startDate` was
    // `t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })` and is now
    // `checkedStartDate`. A year typed one digit at a time makes `82026-12-01`,
    // which fails both — the 2026-08-09 observation `DateField` was built for.
    // Before the refactor that arrived as `http_422` and got the sentence
    // below; without this entry it arrives as `invalid_body` and gets
    // `That change could not be completed (invalid_body).`, with no reread.
    const api = await threeRoots();
    let reads = 0;
    const realTree = api.tree.bind(api);
    api.tree = (projectId: string) => {
      reads += 1;
      return realTree(projectId);
    };
    api.patchWorkItem = () => Promise.reject(new Error('invalid_body'));

    fireEvent.change(screen.getByLabelText('Name of 020'), { target: { value: 'Sand it' } });
    fireEvent.blur(screen.getByLabelText('Name of 020'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change was not valid, so nothing was saved — what is on screen was read again.',
      );
    });
    // The wire token never reaches the reader, the same bar the sibling holds
    // `http_422` to.
    expect(toastTexts().join(' ')).not.toContain('invalid_body');
    // And the sentence's claim is honest: the plan really was read again.
    await waitFor(() => {
      expect(reads).toBe(1);
    });
  });

  itDom('puts a code it has no sentence for inside one', async () => {
    // The grammatical fallback `auth-form.tsx` established. A code nobody has
    // written a sentence for is still a sentence, with the word in brackets for
    // whoever is reading the console beside it.
    // Proof: the fallback replaced by the bare code, this failed on `expected
    // [ 'unknown_strategy' ] to include 'That change could not be completed
    // (unknown_strategy).'`. Watched, 2026-08-09.
    const api = await threeRoots();
    api.removeWorkItem = () => Promise.reject(new Error('unknown_strategy'));

    takeRowAction('020', 'Delete');

    await waitFor(() => {
      expect(toastTexts()).toContain('That change could not be completed (unknown_strategy).');
    });
  });

  itDom('raises the stale-tree banner when a socket refetch fails', async () => {
    const { api, notify } = await subscribedTable();
    const realTree = api.tree.bind(api);
    api.tree = () => Promise.reject(new Error('offline'));

    act(() => {
      notify();
    });

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    expect(staleBanner()?.textContent).toContain('may be out of date');
    // The rows that were on screen are still on screen: a failed refetch does
    // not throw the plan away, it says the plan may have moved on without it.
    expect(numbersOnScreen()).toEqual([]);
    // Nobody asked for this refetch, so nothing was refused: no toast.
    expect(toastTexts()).toEqual([]);

    api.tree = realTree;
    click('Retry');

    await waitFor(() => {
      expect(staleBanner()).toBeNull();
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('clears the banner on a later successful refetch from any path', async () => {
    // The retry button is one way back; somebody else's edit arriving and
    // refetching cleanly is another, and it is the common one.
    const { api, notify } = await subscribedTable();
    const realTree = api.tree.bind(api);
    api.tree = () => Promise.reject(new Error('offline'));

    act(() => {
      notify();
    });
    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });

    api.tree = realTree;
    act(() => {
      notify();
    });

    await waitFor(() => {
      expect(staleBanner()).toBeNull();
    });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('raises the banner when the refetch after an edit fails', async () => {
    const api = await threeRoots();
    api.tree = () => Promise.reject(new Error('offline'));

    typeName('010', 'Renamed');
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    // The edit itself was taken. Only the reread failed, so there is nothing
    // to refuse and nothing to toast.
    expect(toastTexts()).toEqual([]);
  });

  itDom('reports every refused dependency in one toast, not one each', async () => {
    // The reviewers killed a toast per change for being noise. Three lines
    // saying three halves of one answer is the same failure.
    const api = await threeRoots();
    const real = api.addDependency.bind(api);
    api.addDependency = (id: string, predecessorId: string) => {
      const number = api.rows.find((r) => r.id === predecessorId)?.number;
      if (number === '010' || number === '020') return Promise.reject(new Error('cycle'));
      return real(id, predecessorId);
    };

    typeDeps('030', '010, 020, 999');

    await waitFor(() => {
      expect(toastTexts()).toHaveLength(1);
    });
    const said = toastTexts()[0] ?? '';
    expect(said).toContain('999');
    expect(said).toContain('010 (cycle)');
    expect(said).toContain('020 (cycle)');
  });

  itDom('shows both the refusal and the banner when the refetch failed too', async () => {
    // Two different facts: the request was refused, and what is on screen may
    // no longer be what be-01 holds. Reporting one of them would be a lie by
    // omission whichever one was dropped.
    const api = await threeRoots();
    api.addDependency = () => Promise.reject(new Error('cycle'));
    api.tree = () => Promise.reject(new Error('offline'));

    // A list, not one number: a single number is taken by the picker's
    // highlight and goes through `run`, which does not reread after a refusal.
    // The combined path is the one that refuses and rereads in one gesture.
    typeDeps('030', '010, 020');

    await waitFor(() => {
      expect(staleBanner()).not.toBeNull();
    });
    expect(toastTexts()).toEqual([expect.stringContaining('010 (cycle), 020 (cycle)')]);
  });
});

describe('a click made while a save is in flight', () => {
  itDom('says the toolbar is busy, and marks the controls the wait holds back', async () => {
    // What the wait looks like, now that it no longer eats what arrives during
    // it. The drop *was* real — reproduced in Chrome on 2026-08-09, a ⌘+Enter
    // and an immediate click producing a PATCH, two GETs and **no POST at
    // all** — and this test was written to make it visible because "queuing
    // the click is a design decision nobody has made". It has been made, on
    // 2026-08-23, after dev measured 6 clicks at 350ms producing 3 rows: `Add
    // work item` queues, so it is the one toolbar write that is **not**
    // `disabled={busy}`. The affordance is what stayed.
    //
    // Proof: `aria-busy={busy}` pinned to `false` on the toolbar, this failed
    // on `expected 'false' to be 'true'`; and `busyAffordance(busy)` dropped
    // from `Add work item`, it failed on `expected '' to be 'progress'`.
    // Both watched, 2026-08-09.
    const api = await threeRoots();
    const finish: (() => void)[] = [];
    api.patchWorkItem = () => new Promise<void>((resolve) => finish.push(resolve));

    const toolbar = document.querySelector('[data-toolbar]');
    if (toolbar === null) throw new Error('the table rendered no toolbar');
    expect(toolbar.getAttribute('aria-busy')).toBe('false');

    fireEvent.change(screen.getByLabelText('Name of 010'), { target: { value: 'Strip it' } });
    fireEvent.blur(screen.getByLabelText('Name of 010'));

    const add = screen.getByRole('button', { name: 'Add work item' });
    await waitFor(() => {
      expect(toolbar.getAttribute('aria-busy')).toBe('true');
    });
    // Takeable throughout, unlike `Freeze #` beside it: the click is queued
    // rather than refused, which is the whole of `add-item-drops-clicks`.
    expect(add).toHaveProperty('disabled', false);
    // The freeze menu's **trigger**, since `plan-toolbar-controls`: the two
    // writes it holds were `disabled={busy}` buttons, and the one control that
    // replaced them carries the same refusal in the same place.
    expect(screen.getByRole('button', { name: 'Freeze #' })).toHaveProperty('disabled', true);
    expect(add.style.cursor).toBe('progress');
    expect(add.hasAttribute('data-busy')).toBe(true);

    await act(async () => {
      finish[0]?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(toolbar.getAttribute('aria-busy')).toBe('false');
    });
    expect(add.style.cursor).toBe('');
    expect(add.hasAttribute('data-busy')).toBe(false);
  });

  itDom('leaves Undo-with-nothing-to-undo plain, because waiting will not help it', async () => {
    // The distinction the affordance draws. `Undo` is `disabled={busy || !undoable}`
    // and an empty stack is not a wait — a progress cursor over it would be a
    // lie about something that is not going to change on its own.
    await threeRoots();

    const undo = screen.getByRole('button', { name: 'Undo' });

    expect(undo).toHaveProperty('disabled', true);
    expect(undo.style.cursor).toBe('');
    expect(undo.hasAttribute('data-busy')).toBe(false);
  });
});

describe('undo and redo', () => {
  /** The chord as a browser delivers it, with `Z` uppercased by Shift. */
  const pressUndo = (target: Element, shiftKey = false) =>
    fireEvent.keyDown(target, { key: shiftKey ? 'Z' : 'z', ctrlKey: true, shiftKey });

  itDom('undoes the last change and says what it undid', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
    await waitFor(() => {
      expect(toastTexts()).toContain('Undid: rename “Strip”');
    });
  });

  itDom('leaves ctrl-z alone inside a name cell, where the browser owns it', async () => {
    const api = await threeRoots();

    // The return value is `false` when something called `preventDefault`. A
    // half-typed word is the browser's to undo, and taking the chord here
    // would reverse a change that has landed instead of the letters on screen.
    const stillTheBrowsers = pressUndo(screen.getByLabelText('Name of 010'));

    expect(stillTheBrowsers).toBe(true);
    expect(api.stackCalls).toEqual([]);
    expect(toastTexts()).toEqual([]);
  });

  itDom('redoes what was undone', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: true, done: 'rename “Strip”', detail: null });

    pressUndo(screen.getByRole('table'), true);

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['redo']);
    });
    await waitFor(() => {
      expect(toastTexts()).toContain('Redid: rename “Strip”');
    });
  });

  itDom('names the change that stood in the way when an undo is refused', async () => {
    // be-01's own sentence, ended: it used to stop at `has changed since`, with
    // no full stop and no answer to "since what?", while every toast beside it
    // was a whole sentence. Read on screen on 2026-08-09.
    const api = await threeRoots();
    api.answerStackWith({
      ok: false,
      reason: 'stale_undo',
      detail: '“Sand it twice” has changed since then.',
    });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That could not be undone: “Sand it twice” has changed since then.',
      );
    });
  });

  itDom('says whose stack is empty rather than leaving the key silent', async () => {
    const api = await threeRoots();
    api.answerStackWith({ ok: false, reason: 'nothing_to_undo', detail: null });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'There are none of your own changes left to undo on this plan.',
      );
    });
  });

  itDom('says a partial restore out loud rather than reporting a clean undo', async () => {
    const api = await threeRoots();
    api.answerStackWith({
      ok: true,
      done: 'delete “Strip”',
      detail: 'put back without 1 dependency the plan no longer allows (not_found)',
    });

    pressUndo(screen.getByRole('table'));

    await waitFor(() => {
      expect(toastTexts()).toContain(
        'Undid: delete “Strip” — put back without 1 dependency the plan no longer allows (not_found)',
      );
    });
  });

  itDom('greys the buttons out until be-01 says there is something in that half', async () => {
    const api = await threeRoots();

    expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', true);

    // be-01 is the only thing that knows: the stack is per account, and
    // somebody else's edit can empty this reader's redo branch.
    api.stack.undoable = true;
    // Any refetch carries the answer; a socket event is the one nobody asked
    // for, which is exactly the case the buttons must still follow.
    click('Add work item');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
    });
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', true);
  });

  itDom('undoes from the toolbar for anyone who never learns the chord', async () => {
    const api = await threeRoots();
    api.stack.undoable = true;
    click('Add work item');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', false);
    });

    click('Undo');

    await waitFor(() => {
      expect(api.stackCalls).toEqual(['undo']);
    });
  });
});

describe('a step changing, and what the table does about it', () => {
  /**
   * The Steps section, from the toolbar control somebody really clicks and
   * then the tab inside it — the two gestures `project-config-modal` made of
   * the one button this used to be.
   */
  const openSteps = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
  };

  /**
   * Closes the modal, retrying while a write is still landing: the modal
   * refuses its ✕ while any section reports a change in flight, and the
   * section's `busy` clears a microtask after the reread that put the new
   * column on the table — so the first click after `Remove Design` appears
   * can be one the modal is entitled to refuse.
   */
  const closeSteps = async (): Promise<void> => {
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  };

  /*
   * Both helpers wait for the **dialog's** own list to settle before closing,
   * and only then look at the table. An open Radix dialog puts `aria-hidden`
   * on everything else in the document, so a query for a column header while
   * the surface is up answers "not there" whatever the table is really showing
   * — a wait that could never fail, and it was written that way first.
   */

  /** Adds a step through the dialog and waits for the column to arrive. */
  async function addStep(name: string): Promise<void> {
    openSteps();
    fireEvent.change(screen.getByLabelText('New step'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await screen.findByRole('button', { name: `Remove ${name}` });
    await closeSteps();
    await screen.findByRole('button', { name: `Unfold ${name} estimates` });
  }

  /** Removes a step through the dialog and waits for the column to go. */
  async function removeStep(name: string): Promise<void> {
    openSteps();
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name}` }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `Remove ${name}` })).toBeNull();
    });
    await closeSteps();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: `Unfold ${name} estimates` })).toBeNull();
    });
  }

  /** One empty root row, with both seeded steps still there. */
  async function oneRow() {
    const api = fakeApi();
    render(<WbsTable projectId="p1" api={api} />);
    click('Add work item');
    await screen.findByLabelText('Name of 010');
    return api;
  }

  itDom('takes the columns of a step that has gone, unfolded and all', async () => {
    // The accordion is left holding `step-qa` on purpose — see
    // `settleAgainstSteps`. Nothing can observe that, because `columns` is
    // built by mapping over `steps` and a dead id selects no step to unfold;
    // what this measures is the columns following the steps.
    // Proof: `setSteps` made to keep whatever it first loaded, so a later read
    // could not take a step away, this failed in `removeStep` on `expected
    // <button …(2)></button> to be null` — the removed step's fold button
    // still in the table's header. Watched, 2026-08-09.
    await oneRow();
    unfoldStep('QA');
    expect(screen.getByRole('table').style.minWidth).toBe('1459px');

    await removeStep('QA');

    // One step left, folded: 815px of visible fixed columns (827 → 839 → 879 in
    // `number-column-widen` and then `external-refs`, 879 → 855 on 2026-08-31,
    // then 815 when Links joined the initial hide-list), 200 for Name, 96 for it.
    expect(screen.getByRole('table').style.minWidth).toBe('1111px');
    expect(screen.queryByLabelText('QA optimistic for 010')).toBeNull();
  });

  itDom('drops a half-typed figure for a step that has gone', async () => {
    // Observable because a pending draft **vetoes** the backspace removal of an
    // otherwise empty row: typing counts as content. A draft for a step that
    // no longer exists would go on vetoing forever, over a figure nobody can
    // see, reach or finish.
    await oneRow();
    unfoldStep('QA');
    const box = screen.getByLabelText<HTMLInputElement>('QA optimistic for 010');
    fireEvent.change(box, { target: { value: '5' } });
    fireEvent.blur(box);

    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });
    // Still there: the draft is content, and this is the state the assertion
    // below is measured against.
    expect(numbersOnScreen()).toEqual(['010']);

    await removeStep('QA');

    const after = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    after.setSelectionRange(0, 0);
    fireEvent.keyDown(after, { key: 'Backspace' });

    await waitFor(() => {
      expect(numbersOnScreen()).toEqual([]);
    });
  });

  itDom('keeps the drafts of the steps that stayed', async () => {
    // The other half, and the reason the sanitizer is a filter rather than a
    // clear: a step going must not take the figures of the ones that remain.
    await oneRow();
    unfoldStep('Dev');
    const dev = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    fireEvent.change(dev, { target: { value: '7' } });
    fireEvent.blur(dev);

    await removeStep('QA');

    // Dev is still unfolded — it is still there, so the set keeps it — and its
    // three boxes are new elements after the rebuild.
    expect(screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010').value).toBe('7');
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    name.setSelectionRange(0, 0);
    fireEvent.keyDown(name, { key: 'Backspace' });
    expect(numbersOnScreen()).toEqual(['010']);
  });

  itDom('rebuilds nothing when the steps came back the same', async () => {
    // A step change is the **one** sanctioned remount, and this is the other
    // side of that sentence: a read that changed no step must cost nobody
    // their place. `steps` is `columns`' dependency, so an array replaced on
    // every read rebuilds every column definition and unmounts every cell.
    // Proof: `sameSteps` made to answer false, this failed on `expected <body
    // style><div>…(1)</div></body> to be <input …(5)></input>` — the focused
    // box unmounted by a reread that changed nothing. Watched, 2026-08-09.
    await oneRow();
    unfoldStep('Dev');
    const box = screen.getByLabelText<HTMLInputElement>('Dev optimistic for 010');
    box.focus();

    // A reread of the whole project, which is what any edit and any socket
    // event makes this table do.
    //
    // Two changes of shape here, both `plan-toolbar-controls`', and neither a
    // change of subject. The write is a **menu item** now, so it is taken
    // outside the `act` — an async `act` batches its callback's updates until
    // the end, so the menu the click opens is not on the page for the click
    // that takes the item. And the caret is put back by hand, because every
    // menu here returns the focus to its own trigger on the way out. The fault
    // watched is unchanged: a reread that rebuilt the columns unmounts `box`,
    // and the focus on a detached node is `<body>`.
    takeFreezeAction('Freeze numbering');
    box.focus();
    await act(async () => {
      await new Promise((resume) => setTimeout(resume, 0));
    });

    expect(document.activeElement).toBe(box);
  });

  itDom('keeps a draft be-01 refused when a new step rebuilds every column', async () => {
    // The one sanctioned remount: a step change really does rebuild the
    // columns, and every cell in the table is a new element afterwards. The
    // focus goes with it, by design — but a refused draft is text that exists
    // nowhere else, and `CellInput`'s rule 4 held it in a ref that dies with
    // the component.
    const api = await oneRow();
    api.patchWorkItem = () => Promise.reject(new Error('forbidden'));
    const name = screen.getByLabelText<HTMLTextAreaElement>('Name of 010');
    fireEvent.change(name, { target: { value: 'Strip the wiring' } });
    fireEvent.blur(name);
    await waitFor(() => {
      expect(toastTexts()).toContain(
        'That change could not be completed: this plan is not yours to change.',
      );
    });

    await addStep('Design');

    expect(screen.getByLabelText<HTMLTextAreaElement>('Name of 010').value).toBe(
      'Strip the wiring',
    );
  });

  itDom('forgets a refusal held for a step that has gone', async () => {
    // The held refusals are keyed by cell, and a cell of a step that no longer
    // exists is one nobody can ever resolve — it would sit in the map for the
    // life of the page.
    const api = await oneRow();
    api.setEstimate = () => Promise.reject(new Error('forbidden'));
    const folded = screen.getByLabelText<HTMLInputElement>('QA estimate for 010');
    fireEvent.change(folded, { target: { value: '9' } });
    fireEvent.blur(folded);
    await waitFor(() => {
      expect(refusedDraftFor('w1::step-qa-final')).toBe('9');
    });

    await removeStep('QA');

    expect(refusedDraftFor('w1::step-qa-final')).toBeUndefined();
  });
});
