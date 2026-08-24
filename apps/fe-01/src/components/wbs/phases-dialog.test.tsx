import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RoleUsage, RoleView } from '@/lib/wbs-api';

import { flipSentence, PhasesDialog, usageSentence } from './phases-dialog';
import type * as TableFrame from './table-frame';
import { foldedTableMinWidth, type FrameLayoutState } from './table-frame';

/**
 * The width module with its folded-minimum function watched.
 *
 * Spied rather than replaced — the real arithmetic still runs, and every other
 * assertion here still reads the real number. The one thing a spy adds is the
 * only thing nothing else can see: **which ids** the dialog resolved against.
 * `<roleId>-final` is 96px whatever the role is called, so a stand-in id and a
 * real one produce the same figure and no rendered output can tell them apart.
 */
vi.mock('./table-frame', async (importOriginal) => {
  const actual = await importOriginal<typeof TableFrame>();
  return { ...actual, foldedTableMinWidth: vi.fn(actual.foldedTableMinWidth) };
});

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

afterEach(cleanup);

const DEV: RoleView = { id: 'role-dev', name: 'Dev' };
const QA: RoleView = { id: 'role-qa', name: 'QA' };

/** A plan where no row sets an earliest start, which is what a fresh project is. */
const UNDATED: FrameLayoutState = { hasAnyNotBefore: false };
/** And one where somebody has, which is 28px wider. */
const DATED: FrameLayoutState = { hasAnyNotBefore: true };

const NUMBERS: Record<string, string> = { w1: '010', w2: '020' };
const PEOPLE: Record<string, string> = { p1: 'Kat', p2: 'Ada' };

/** Everything the dialog is given, with each call recorded. */
function stubbed(overrides: Partial<Parameters<typeof PhasesDialog>[0]> = {}) {
  const addRole = vi.fn(() => Promise.resolve({ id: 'role-design', name: 'Design' }));
  const renameRole = vi.fn(() => Promise.resolve({ id: 'role-qa', name: 'Review' }));
  const removeRole = vi.fn(() => Promise.resolve({ ok: true }));
  const onChanged = vi.fn(() => Promise.resolve());
  const props = {
    roles: [DEV, QA],
    frameState: UNDATED,
    numberOf: (id: string) => NUMBERS[id] ?? null,
    nameOf: (id: string) => PEOPLE[id] ?? null,
    addRole,
    renameRole,
    removeRole,
    onChanged,
    ...overrides,
  };
  render(<PhasesDialog {...props} />);
  // Opened through its own trigger, because the trigger is the component's now:
  // Radix restores the focus to it on close and to nothing without one.
  fireEvent.click(screen.getByRole('button', { name: 'Phases' }));
  return { addRole, renameRole, removeRole, onChanged, props };
}

/** Lets the two awaits every change makes — the call, then the reread — settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resume) => setTimeout(resume, 0));
  });
}

const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('the phases a project holds', () => {
  itDom('lists every phase, each with a way to rename it and remove it', () => {
    stubbed();

    expect(screen.getByLabelText('Dev')).toHaveProperty('value', 'Dev');
    expect(screen.getByLabelText('QA')).toHaveProperty('value', 'QA');
    expect(screen.getByRole('button', { name: 'Remove Dev' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove QA' })).toBeDefined();
  });

  itDom('adds a phase and rereads the project', async () => {
    const stub = stubbed();

    type('New phase', 'Design');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    await settle();

    expect(stub.addRole).toHaveBeenCalledWith('Design');
    // The reread is what puts the column on the table. Without it the dialog
    // would be the only thing on the page that knew about the new phase.
    expect(stub.onChanged).toHaveBeenCalled();
  });

  itDom('renames a phase to what was typed over it', async () => {
    const stub = stubbed();

    type('QA', 'Review');
    fireEvent.submit(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameRole).toHaveBeenCalledWith('role-qa', 'Review');
  });

  itDom('renames on the way out of the box, not only on Enter', async () => {
    // Every other text field in this product commits on blur. This one took
    // Enter and nothing else, so a rename typed and then abandoned — ✕, Tab,
    // anything — was dropped without a PATCH, a toast or a mark on the field,
    // and `onOpenChange` clearing `renamed` is what made it silent. Observed on
    // 2026-08-09.
    //
    // Proof: the `onBlur` handler removed from the rename box, this failed on
    // `expected "spy" to be called with arguments: [ 'role-qa', 'Review' ]` —
    // never called at all, and so did `keeps a rename that was typed and then
    // the dialog closed on it`. Both watched, 2026-08-09.
    const stub = stubbed();

    type('QA', 'Review');
    fireEvent.blur(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameRole).toHaveBeenCalledWith('role-qa', 'Review');
  });

  itDom('keeps a rename that was typed and then the dialog closed on it', async () => {
    // The gesture the finding was filed for: type over the name, then close the
    // dialog by its own ✕. A browser blurs the field before the click lands —
    // jsdom performs no focus change of its own, so the blur is delivered here
    // in the order a browser delivers it.
    const stub = stubbed();

    const box = screen.getByLabelText('QA');
    box.focus();
    type('QA', 'Review');
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    expect(stub.renameRole).toHaveBeenCalledWith('role-qa', 'Review');
  });

  itDom('sends nothing on the way out of a box nobody typed in', async () => {
    // The other half, and what keeps the blur commit from being a rename on
    // every click through the list: leaving a box unchanged is not an edit.
    const stub = stubbed();

    fireEvent.blur(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameRole).not.toHaveBeenCalled();
  });

  itDom('sends nothing for a name that is only spaces', async () => {
    const stub = stubbed();

    type('New phase', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    await settle();

    // Refused here rather than by be-01: the answer is the same and this one
    // needs no round trip.
    // Proof: the `clean === ''` guard removed, this failed on `expected "spy"
    // to not be called at all, but it was called 1 time`. Watched, 2026-08-09.
    expect(stub.addRole).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A phase needs a name.');
  });

  itDom('sends nothing when a name is submitted unchanged', async () => {
    const stub = stubbed();

    fireEvent.submit(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameRole).not.toHaveBeenCalled();
  });

  itDom('says what refused it, in words rather than in be-01’s code', async () => {
    const stub = stubbed({ addRole: vi.fn(() => Promise.reject(new Error('taken'))) });

    type('New phase', 'Dev');
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    await settle();

    expect(screen.getByRole('alert').textContent).toBe(
      'That name is already a phase on this plan.',
    );
    expect(document.body.textContent).not.toContain('taken');
    expect(stub.onChanged).not.toHaveBeenCalled();
  });
});

describe('leaving the surface', () => {
  itDom('gives the focus back to the button that opened it', async () => {
    stubbed();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();

    // Radix's `onCloseAutoFocus` calls `preventDefault()` and then focuses its
    // **trigger** — so a dialog opened without a `ModalTrigger` cancels the
    // default restore and puts the focus nowhere. Found in a browser, where
    // `Escape closes it and gives the focus back to the button that opened it`
    // failed on `expect(locator).toBeFocused()` with `<body>` holding it.
    // Proof: `ModalTrigger` swapped for a plain `Button` with an `onClick`,
    // this failed on `expected <body style><div>…(1)</div></body> to be
    // <button …(3)></button>`. Watched, 2026-08-09.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Phases' }));
  });

  itDom('leaves no half-answered confirmation behind', async () => {
    // A confirmation somebody walked away from is not one they agreed to.
    const removeRole = vi.fn((_roleId: string, cascade: boolean) =>
      cascade
        ? Promise.resolve({ ok: true })
        : Promise.resolve({
            ok: false,
            reason: 'in_use' as const,
            inUse: { estimates: 1, assignments: 0, assumedAssignees: [] },
          }),
    );
    stubbed({ removeRole });
    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    expect(screen.getByLabelText('Delete them along with the phase')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Phases' }));

    expect(screen.queryByLabelText('Delete them along with the phase')).toBeNull();
  });
});

describe('the chord on the surface', () => {
  itDom('submits the form the keystroke was aimed at', async () => {
    const stub = stubbed();

    type('New phase', 'Design');
    // The chord `F shadcn-foundation`'s second round made reachable: the first
    // version of `usePageShortcutsSuspended` ended it in the capture phase and
    // this handler could never have run.
    // Proof: `onChord` returning early for every keystroke, this failed on
    // `expected "spy" to be called with arguments: [ 'Design' ]`. Watched,
    // 2026-08-09.
    fireEvent.keyDown(screen.getByLabelText('New phase'), {
      key: 'Enter',
      metaKey: true,
      code: 'Enter',
    });
    await settle();

    expect(stub.addRole).toHaveBeenCalledWith('Design');
  });

  itDom('submits the rename it was pressed in, not the add box', async () => {
    const stub = stubbed();

    type('QA', 'Review');
    fireEvent.keyDown(screen.getByLabelText('QA'), {
      key: 'Enter',
      ctrlKey: true,
      code: 'Enter',
    });
    await settle();

    expect(stub.renameRole).toHaveBeenCalledWith('role-qa', 'Review');
    expect(stub.addRole).not.toHaveBeenCalled();
  });

  itDom('leaves a bare Enter to the form it is in', async () => {
    // Not a chord at all — `commandChord` answers null — so nothing here claims
    // it and the browser's own submit does the work.
    // Proof: `onChord` widened to fire on any `Enter`, this failed on `expected
    // "spy" to not be called at all, but actually been called 1 times`.
    // Watched, 2026-08-09.
    const stub = stubbed();

    type('New phase', 'Design');
    fireEvent.keyDown(screen.getByLabelText('New phase'), { key: 'Enter', code: 'Enter' });
    await settle();

    expect(stub.addRole).not.toHaveBeenCalled();
  });
});

describe('removing a phase', () => {
  const IN_USE: RoleUsage = {
    estimates: 2,
    assignments: 1,
    assumedAssignees: [{ workItemId: 'w2', assumedNow: null, assumedAfter: 'p1' }],
  };
  const refusing = () =>
    vi.fn((_roleId: string, cascade: boolean) =>
      cascade
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ ok: false, reason: 'in_use' as const, inUse: IN_USE }),
    );

  itDom('asks without a cascade first, and shows what would go', async () => {
    const removeRole = refusing();
    stubbed({ removeRole });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();

    expect(removeRole).toHaveBeenCalledWith('role-qa', false);
    expect(document.body.textContent).toContain(
      'Removing QA would delete 2 estimates and 1 assignment.',
    );
    // The flip, by the work item's **number**: an id in a confirmation is a
    // fact nobody reading the plan can act on.
    expect(document.body.textContent).toContain(
      '020: nobody is assumed to be doing all of it now, Kat would be afterwards.',
    );
  });

  itDom('sends nothing when the confirmation is agreed to without the box', async () => {
    const removeRole = refusing();
    stubbed({ removeRole });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    const confirm = screen.getByRole('button', { name: 'Remove QA' });

    // The default this whole flow exists for.
    // Proof: the confirmation opened with `cascade: true`, this failed on
    // `expected <button …(2)></button> to have property "disabled" with value
    // true` — the confirm was live on arrival and one click would have taken
    // the estimates with it. Watched, 2026-08-09.
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.click(confirm);
    await settle();

    expect(removeRole).toHaveBeenCalledTimes(1);
  });

  itDom('removes it once the box is ticked', async () => {
    const removeRole = refusing();
    const stub = stubbed({ removeRole });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    fireEvent.click(screen.getByLabelText('Delete them along with the phase'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();

    expect(removeRole.mock.calls).toEqual([
      ['role-qa', false],
      ['role-qa', true],
    ]);
    expect(stub.onChanged).toHaveBeenCalled();
  });

  itDom('keeps the phase, and asks nothing more, when the confirmation is dropped', async () => {
    const removeRole = refusing();
    stubbed({ removeRole });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Keep QA' }));
    await settle();

    expect(removeRole).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('New phase')).toBeDefined();
  });

  itDom('takes a phase nobody uses without asking at all', async () => {
    // be-01 removes one nothing points at outright, so there is nothing to
    // confirm — and asking anyway is how people learn to confirm without
    // reading.
    const stub = stubbed();

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await waitFor(() => {
      expect(stub.onChanged).toHaveBeenCalled();
    });

    expect(screen.queryByLabelText('Delete them along with the phase')).toBeNull();
  });
});

describe('how wide the phases make the table', () => {
  itDom('says the width, from the table’s own columns', () => {
    stubbed({ roles: [DEV, QA] });

    // 839px of fixed columns on a plan nobody has dated, 200 for Name, 96 each
    // for two folded phases (827 → 839 in `number-column-widen`, 93 → 105 in
    // `COLUMN_WIDTHS`). Renderer-neutral wording: this dialog opens from the
    // phone's toolbar sheet too, and the sentence used to describe a table
    // that reader has never seen.
    expect(document.body.textContent).toContain(
      '2 phases need ≥1231px of width to sit side by side',
    );
    expect(document.body.textContent).toContain(
      'under 768px wide or 500px tall the plan is drawn as cards instead',
    );
    expect(document.body.textContent).not.toContain('before the table scrolls sideways');
  });

  itDom('quotes the table’s own arithmetic, not a sum of its own', () => {
    // The number moves with every width the table declares, including the ones
    // that depend on the plan: the same two phases are 28px wider once
    // somebody sets an earliest start anywhere in the project.
    //
    // Proof: `minWidth` in `phases-dialog.tsx` replaced by the hand-written
    // `952 + roles.length * 96` this sentence used to quote, this failed on
    // `expected '…≥1144px…' to contain '≥1123px'` for the undated plan and on
    // `≥1151px` for the dated one — one number where the table lays out two.
    // Watched, 2026-08-09, when those two figures were the table's; they were
    // 1219 and 1247 since `priority-column`, and are 1231 and 1259 since
    // `number-column-widen` — the assertions below read them from the layout
    // rather than repeating them.
    cleanup();
    stubbed({ roles: [DEV, QA], frameState: UNDATED });
    expect(document.body.textContent).toContain(
      `≥${String(foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED))}px`,
    );

    cleanup();
    stubbed({ roles: [DEV, QA], frameState: DATED });
    expect(document.body.textContent).toContain(
      `≥${String(foldedTableMinWidth(['role-dev', 'role-qa'], DATED))}px`,
    );
    expect(
      foldedTableMinWidth(['role-dev', 'role-qa'], DATED) -
        foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED),
    ).toBe(28);
  });

  itDom('resolves the project’s own role ids, not stand-ins for the count', () => {
    // A width can be resolved per column id now, which is what makes an id a
    // fact rather than a placeholder: `T1 column-widths-drag` stores a
    // reader's override under the exact column id, and a `phase0-final`
    // invented here could never carry one. The two resolve to the same 96 px
    // today, so nothing measurable tells them apart — the call is what says
    // which was asked about.
    //
    // Proof: `roles.map((role) => role.id)` replaced by the
    // `Array.from({ length: roles.length }, (_, at) => \`phase${at}\`)` this
    // used to be, this failed on `expected [ 'phase0', 'phase1' ] to deeply
    // equal [ 'role-dev', 'role-qa' ]`. Watched, 2026-08-09.
    stubbed({ roles: [DEV, QA] });

    expect(vi.mocked(foldedTableMinWidth).mock.calls.at(-1)?.[0]).toEqual(['role-dev', 'role-qa']);
  });

  itDom('quotes a phase’s dragged width, because it resolved that phase’s own column', () => {
    // The half of "real ids, not stand-ins" that has a number attached to it.
    // A reader who drags the Dev column wider is looking at a wider table, and
    // the figure that says how much width the phases need has to be that
    // table's. It can only be, because the override is stored under
    // `role-dev-final` — the id the table renders that column by — and this
    // dialog resolves the project's own role ids.
    //
    // Proof: `roles.map((role) => role.id)` replaced by the stand-in
    // `Array.from({ length: roles.length }, (_, at) => \`phase${at}\`)`, this
    // failed on `expected 'PhasesPhasesThe phases every work ite…' to contain
    // '≥1167px'` — the dialog
    // quoting the default 96px column while the table lays out the dragged
    // 140px one. Watched, 2026-08-09.
    const dragged: FrameLayoutState = {
      hasAnyNotBefore: false,
      columnWidthOverrides: new Map([['role-dev-final', 140]]),
    };
    stubbed({ roles: [DEV, QA], frameState: dragged });

    const quoted = foldedTableMinWidth(['role-dev', 'role-qa'], dragged);
    expect(document.body.textContent).toContain(`≥${String(quoted)}px`);
    // And it really moved: a figure that ignored the override would be the
    // undated default, which is what a stand-in id resolves to.
    expect(quoted).toBe(foldedTableMinWidth(['role-dev', 'role-qa'], UNDATED) + (140 - 96));
  });

  itDom('counts one phase as one, and says so in the singular throughout', () => {
    // The noun and the **verb**. This asserted `'1 phase need'` until
    // 2026-08-14: it was written about `count`'s singular noun and swept the
    // plural verb beside it up in the same `toContain`, so the sentence a
    // single-phase plan really showed — `1 phase need ≥1123px` — was pinned by
    // the test that was meant to be checking it. The whole clause is asserted
    // now, which is the only spelling that can see the verb.
    //
    // Proof: the verb put back to a flat `need`, this failed on
    // `expected 'PhasesPhasesThe phases every work ite…' to contain
    // '1 phase needs ≥1123px of width to sit…'`. Watched on h2puni, 2026-08-14 (fault F5).
    stubbed({ roles: [DEV] });

    // 1123 → 1135 in `number-column-widen` (93 → 105 in `COLUMN_WIDTHS`).
    expect(document.body.textContent).toContain('1 phase needs ≥1135px of width to sit side by');
    expect(document.body.textContent).not.toContain('1 phase need ≥');
  });

  itDom('keeps the plural where there is more than one phase', () => {
    // The other arm, and it is here so the fix above cannot be "never say
    // `need`" — a singular-only expression satisfies the test above and reads
    // `2 phases needs` on every real plan.
    //
    // Proof: the plural arm made to say `needs` as well, this failed on
    // `expected 'PhasesPhasesThe phases every work ite…' to contain
    // '2 phases need ≥1219px of width to sit…'`. Watched on h2puni, 2026-08-14 (fault F6).
    stubbed({ roles: [DEV, QA] });

    // 1219 → 1231 in `number-column-widen` (93 → 105 in `COLUMN_WIDTHS`).
    expect(document.body.textContent).toContain('2 phases need ≥1231px of width to sit side by');
    expect(document.body.textContent).not.toContain('2 phases needs');
  });
});

describe('the sentences on their own', () => {
  it('names both counts, even the one that is zero', () => {
    expect(usageSentence('QA', { estimates: 1, assignments: 0, assumedAssignees: [] })).toBe(
      'Removing QA would delete 1 estimate and 0 assignments.',
    );
  });

  it('says who stops being assumed to do everything', () => {
    expect(
      flipSentence(
        { workItemId: 'w1', assumedNow: 'p1', assumedAfter: null },
        (id) => NUMBERS[id] ?? null,
        (id) => PEOPLE[id] ?? null,
      ),
    ).toBe('010: Kat is assumed to be doing all of it now, nobody would be afterwards.');
  });

  it('names a work item the tree no longer holds by what it is, not by its id', () => {
    // The list came from be-01 and the tree on screen is a moment older. A uuid
    // in a confirmation is a fact nobody can act on, so it is not printed.
    const said = flipSentence(
      { workItemId: 'gone-uuid', assumedNow: null, assumedAfter: 'p2' },
      () => null,
      (id) => PEOPLE[id] ?? null,
    );
    expect(said).not.toContain('gone-uuid');
    expect(said).toContain('A work item no longer on screen');
  });
});
