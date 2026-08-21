import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PRIORITY_BANDS } from '@wbs/domain/priority-band';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { KeyboardCheatSheet } from '@/components/wbs/keyboard-cheat-sheet';
import { WbsTable } from '@/components/wbs/wbs-table';
import type { ProjectApi, WorkItemView } from '@/lib/wbs-api';

import { Modal, ModalContent, ModalTitle } from './modal';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

/** The one row every test here works over, numbered the way be-01 numbers it. */
const ROW: WorkItemView = {
  id: 'row-1',
  parentId: null,
  number: '010',
  name: 'Survey the racking',
  notes: '',
  frozenNumber: null,
  priority: null,
  rolledUp: false,
  revision: 1,
  estimates: {},
  finalDays: {},
  finalTotal: 0,
  dates: null,
  assignees: {},
  doesEveryPhase: null,
  serviceTeamId: null,
  teamIds: [],
  startNoEarlierThan: null,
  dependsOn: [],
  schedule: {
    duration: 0,
    estimated: false,
    earliestStart: 0,
    earliestFinish: 0,
    latestStart: 0,
    latestFinish: 0,
    float: 0,
    critical: true,
  },
};

/** What a test needs: the table's api, and the two calls it asserts never happen. */
interface SilentApi {
  api: ProjectApi;
  /** `api.undo`, held separately — reading it back off the object is an unbound method. */
  undo: Mock;
  create: Mock;
}

/**
 * A ProjectApi that answers, records, and changes nothing.
 *
 * Spies rather than `wbs-table.test.tsx`'s in-memory tree, because what every
 * test here asserts is a **call that must not happen**: `undo` never reached,
 * `create` never reached. A fake that mutated a tree would make the assertion
 * "the row count did not change", which is also true when the request was sent
 * and refused.
 *
 * `Promise.resolve` rather than `async` throughout: a method with nothing to
 * await is one the lint rule rightly asks about, and there is nothing to await
 * in a stand-in that answers from memory.
 */
function silentApi(): SilentApi {
  /** Every write here is a write that must not be made; answering is the whole body. */
  const nothing = () => Promise.resolve();
  const undo = vi.fn(() => Promise.resolve({ ok: true as const, done: 'rename', detail: null }));
  const create = vi.fn(() => Promise.resolve({ id: 'row-2' }));
  return {
    undo,
    create,
    api: {
      listProjects: () => Promise.resolve([]),
      createProject: () => Promise.resolve({ id: 'p', name: 'Plan', restricted: false }),
      openProject: nothing,
      renameProject: nothing,
      tree: () =>
        Promise.resolve({
          workItems: [ROW],
          seq: 1,
          scheduleError: null,
          slices: [],
          roles: [],
          assignedPeople: [],
          // Present and empty, never absent: be-01 always sends it, so a fake that
          // left it out would let `teamsOnThePlan` be handed `undefined` here and
          // never in production. A plan whose teams are unlimited is what `[]` says.
          teamCapacities: [],
          priorityBands: DEFAULT_PRIORITY_BANDS,
          estimateMethod: 'pert' as const,
          startDate: null,
          projectRevision: 1,
          undoable: true,
          redoable: true,
        }),
      undo,
      redo: () => Promise.resolve({ ok: true as const, done: 'rename', detail: null }),
      setEstimateMethod: nothing,
      setStartDate: nothing,
      roles: () => Promise.resolve([{ id: 'role-dev', name: 'Dev' }]),
      addRole: () => Promise.reject(new Error('not_in_these_tests')),
      renameRole: () => Promise.reject(new Error('not_in_these_tests')),
      removeRole: () => Promise.reject(new Error('not_in_these_tests')),
      create,
      patch: nothing,
      listTeams: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
      listServices: () => Promise.resolve([]),
      addTeam: () => Promise.resolve({ id: 't', name: 'T' }),
      listPeople: () => Promise.resolve([]),
      addPerson: () => Promise.resolve({ id: 'person', name: 'Kat', teamIds: [] }),
      assign: nothing,
      move: nothing,
      duplicate: () => Promise.resolve({ id: 'row-3' }),
      remove: nothing,
      setEstimate: nothing,
      clearEstimate: nothing,
      freeze: nothing,
      unfreezeProject: nothing,
      unfreeze: nothing,
      addDependency: nothing,
      removeDependency: nothing,
    },
  };
}

/** The table, on screen with its one row, and its window listeners registered. */
async function renderTable(api: ProjectApi): Promise<void> {
  render(<WbsTable projectId="p" api={api} />);
  await waitFor(() => {
    expect(screen.getByLabelText('Name of 010')).toBeDefined();
  });
}

/**
 * A modal surface built from the vendored wrapper, over whatever is already
 * rendered.
 *
 * @param onFieldKey Called for every keystroke that reaches the text box inside
 * it — which is how the last test asks what the rule did *not* swallow.
 */
function openModal(onFieldKey?: (key: string) => void): void {
  render(
    <Modal open>
      <ModalContent aria-describedby={undefined}>
        <ModalTitle>A dialog a later change will build</ModalTitle>
        <button type="button">Somewhere to aim a keystroke</button>
        <input
          aria-label="Something to type in"
          onKeyDown={(event) => {
            onFieldKey?.(event.key);
          }}
        />
      </ModalContent>
    </Modal>,
  );
}

/** Whether the cheat sheet is on screen, asked without `getByRole`. */
const cheatSheetShowing = (): boolean =>
  document.querySelector('[data-cheat-sheet-backdrop]') !== null;

/**
 * A keystroke aimed at `target`, dispatched the way a browser does.
 *
 * `fireEvent.keyDown` on the element rather than on `window`: the rule under
 * test runs in the **capture** phase at the window, which only exists for an
 * event that has a path through the document to travel. Dispatched on `window`
 * directly there is no capture phase to stop anything in, and the test would
 * pass for a reason that has nothing to do with a browser.
 */
function press(target: Element, key: Record<string, unknown>): void {
  act(() => {
    fireEvent.keyDown(target, key);
  });
}

/**
 * Lets every promise the chord started resolve, so a call that was going to be
 * made has been made by the time it is asserted about.
 *
 * A macrotask rather than `await Promise.resolve()`: the create path is
 * `flushCell` then `run` then `api.create`, three links of a chain, and one
 * microtask drains one of them.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

/*
 * PROVING THE RULE CAN FAIL — watched 2026-08-09, quoted in
 * `openspec/changes/shadcn-foundation/verify.md`.
 *
 * FAULT — `page-shortcuts.ts`, the `window.addEventListener('keydown', swallow,
 * true)` line and its removal commented out, so the hook registers nothing.
 * Every one of the four tests below failed, each on the thing the shortcut
 * would have done: the cheat sheet mounted over the open dialog, `api.undo`
 * called once, `api.create` called once, and the cheat sheet — which is a modal
 * with no focus trap, so a cell really can hold the focus behind it — letting
 * Cmd+Z through.
 */
describe('a modal holds the page’s keyboard back', () => {
  itDom('leaves “?” alone, so the cheat sheet does not open over the dialog', async () => {
    await renderTable(silentApi().api);
    openModal();
    const inside = screen.getByRole('button', { name: 'Somewhere to aim a keystroke' });

    press(inside, { key: '?' });

    expect(cheatSheetShowing()).toBe(false);
  });

  itDom('leaves Cmd+Z alone, so nothing behind the dialog is undone', async () => {
    const stub = silentApi();
    await renderTable(stub.api);
    openModal();
    const inside = screen.getByRole('button', { name: 'Somewhere to aim a keystroke' });

    press(inside, { key: 'z', metaKey: true });

    expect(stub.undo).not.toHaveBeenCalled();
  });

  itDom('leaves a command chord alone, so no work item is created behind it', async () => {
    const stub = silentApi();
    await renderTable(stub.api);
    // The cell is what a chord is pressed in, and a chord aimed at one is what
    // reaches `api.create`. It is reachable behind a modal for real: this app's
    // cheat sheet does not trap the focus and says so, so Tab out of it lands
    // here — which is the fault `agy #10` reported.
    //
    // This is also the **outside**-the-surface half of the rule the second
    // review corrected, and the check that the correction did not widen both
    // sides: with `isOnModalSurface` forced true for every target, this test
    // failed on `api.create` being called once. Watched.
    const cell = screen.getByLabelText('Name of 010');
    openModal();

    press(cell, { key: 'n', ctrlKey: true, code: 'KeyN' });
    // The chord flushes the cell and *then* creates, so `api.create` is two
    // awaits away rather than in this tick. Asserted before the queue drains,
    // this test passed with the rule taken out — watched, and the reason the
    // settle below is here rather than a bare `expect` on the next line.
    await settle();

    expect(stub.create).not.toHaveBeenCalled();
  });

  // The chords, on the surface's own side of the line. Both reviews found this
  // one: the first version of the hook asked `isPageShortcut` about every
  // keystroke wherever it was aimed, and `commandChord` carries no typing guard
  // — deliberately, because a cell is an input — so `Ctrl+Enter` and `Ctrl+H`
  // typed into a dialog's own field were swallowed before the field's handler
  // ran. `P phases-ui`'s dialog wants Cmd+Enter for its submit and could not
  // have had it.
  itDom('lets a command chord reach a field on the surface', async () => {
    await renderTable(silentApi().api);
    const reached: string[] = [];
    openModal((key) => reached.push(key));
    const field = screen.getByLabelText('Something to type in');

    press(field, { key: 'Enter', ctrlKey: true, code: 'Enter' });
    press(field, { key: 'h', ctrlKey: true, code: 'KeyH' });

    expect(reached).toEqual(['Enter', 'h']);
  });

  // The other half of the rule, and the reason the three above are not enough
  // on their own: a hook that swallowed every keystroke would pass all of them
  // and make the dialog untypeable. This is what says the rule is the predicate
  // and not a blanket.
  itDom('leaves the dialog’s own box the keystrokes the page never claimed', async () => {
    await renderTable(silentApi().api);
    const reached: string[] = [];
    openModal((key) => reached.push(key));
    const field = screen.getByLabelText('Something to type in');

    // Cmd+Z aimed at a box somebody is typing in is not the table's undo —
    // `undoChord` answers null for it — so the browser's own undo has to get
    // it. `?` is the same story through `opensCheatSheet`.
    press(field, { key: 'z', metaKey: true });
    press(field, { key: '?' });

    expect(reached).toEqual(['z', '?']);
  });

  // The half none of the six above could see, because every one of them opens
  // the modal first. A dialog that is only *declared* must hold nothing back,
  // and until `P phases-ui` mounted one in the toolbar nothing in the app ever
  // declared a closed modal — so the rule shipped registering its capture
  // listener the moment `ModalContent` was rendered, open or shut.
  //
  // Proof: with `usePageShortcutsSuspended(true)` back in `ModalContent`'s own
  // body, this failed on `expected "spy" to be called at least once` — and 49
  // tests in `wbs-table.test.tsx` failed with it, `outdents with shift-tab` on
  // `expected [ '010' ] to deeply equal [ '010', '020' ]`. Watched 2026-08-09.
  itDom('holds nothing back while the modal is closed', async () => {
    const stub = silentApi();
    await renderTable(stub.api);
    render(
      <Modal open={false}>
        <ModalContent aria-describedby={undefined}>
          <ModalTitle>Declared, and shut</ModalTitle>
        </ModalContent>
      </Modal>,
    );
    const behind = screen.getByRole('button', { name: 'Freeze numbering' });

    press(behind, { key: 'z', metaKey: true });
    await settle();

    expect(stub.undo).toHaveBeenCalled();
  });

  itDom('holds them back for the cheat sheet too, which is a modal without a trap', async () => {
    const stub = silentApi();
    await renderTable(stub.api);
    render(
      <KeyboardCheatSheet
        altStyle="pc"
        renderer="table"
        onClose={() => {
          // Nothing closes it in this test; what is being measured is what
          // happens while it is open.
        }}
      />,
    );
    // A toolbar button, not a cell: `undoChord` answers null for a keystroke
    // aimed at a box somebody is typing in, so a Cmd+Z on a cell is one the
    // page would never have acted on and a test that pressed it there could
    // not fail. Tab out of the untrapped sheet reaches exactly this button.
    const behind = screen.getByRole('button', { name: 'Freeze numbering' });

    press(behind, { key: 'z', metaKey: true });

    expect(stub.undo).not.toHaveBeenCalled();
  });
});
