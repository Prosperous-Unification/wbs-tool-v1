import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DependencyReach } from '@wbs/domain/dependency-reach';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StepUsage, StepView } from '@/lib/wbs-api';

import { flipSentence, StepsPanel, usageSentence } from './steps-panel';
import type * as TableFrame from './table-frame';
import { foldedTableMinWidth, type FrameLayoutState, INITIAL_HIDDEN_COLUMNS } from './table-frame';

/**
 * The width module with its folded-minimum function watched.
 *
 * Spied rather than replaced — the real arithmetic still runs, and every other
 * assertion here still reads the real number. The one thing a spy adds is the
 * only thing nothing else can see: **which ids** the panel resolved against.
 * `<stepId>-final` is 96px whatever the step is called, so a stand-in id and a
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

const DEV: StepView = { id: 'step-dev', name: 'Dev' };
const QA: StepView = { id: 'step-qa', name: 'QA' };

/** A plan where no row sets an earliest start, which is what a fresh project is. */
const UNDATED: FrameLayoutState = { hasAnyNotBefore: false };
/** And one where somebody has, which is 28px wider. */
const DATED: FrameLayoutState = { hasAnyNotBefore: true };

const NUMBERS: Record<string, string> = { w1: '010', w2: '020' };
const PEOPLE: Record<string, string> = { p1: 'Kat', p2: 'Ada' };

/**
 * Everything the panel is given, with each call recorded.
 *
 * Rendered bare, without the modal around it: this suite is about what the
 * section sends and says, and `project-settings-modal.test.tsx` is about the
 * shell — who opens it, who closes it, what it refuses to close over and where
 * the focus goes afterwards. Two cases that used to live here, `gives the focus
 * back to the button that opened it` and `leaves no half-answered confirmation
 * behind`, were about the shell and moved there with it.
 */
function stubbed(overrides: Partial<Parameters<typeof StepsPanel>[0]> = {}) {
  const addStep = vi.fn(() => Promise.resolve({ id: 'step-design', name: 'Design' }));
  const renameStep = vi.fn(() => Promise.resolve({ id: 'step-qa', name: 'Review' }));
  const removeStep = vi.fn(() => Promise.resolve({ ok: true }));
  const setDepReach = vi.fn(() => Promise.resolve());
  const onChanged = vi.fn(() => Promise.resolve());
  const onDirtyChange = vi.fn();
  const props = {
    steps: [DEV, QA],
    depReach: 'whole-item' as DependencyReach,
    setDepReach,
    frameState: UNDATED,
    // The table's own default, so every figure below is the default table's.
    hiddenColumnIds: INITIAL_HIDDEN_COLUMNS,
    numberOf: (id: string) => NUMBERS[id] ?? null,
    nameOf: (id: string) => PEOPLE[id] ?? null,
    addStep,
    renameStep,
    removeStep,
    onChanged,
    onDirtyChange,
    ...overrides,
  };
  render(<StepsPanel {...props} />);
  return { addStep, renameStep, removeStep, setDepReach, onChanged, onDirtyChange, props };
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

describe('the steps a project holds', () => {
  itDom('quotes the folded width of the columns actually on screen', () => {
    // `configurable-columns`: a reader who has hidden Depends on is 86px
    // narrower than the default table, and the sentence has to say so — the
    // spy is what sees **which** hidden list the figure was resolved against,
    // since a stand-in list and the real one print the same kind of number.
    stubbed({ hiddenColumnIds: ['depends'] });
    const spy = vi.mocked(foldedTableMinWidth);
    expect(spy).toHaveBeenLastCalledWith(['step-dev', 'step-qa'], UNDATED, ['depends']);
    const quoted = String(foldedTableMinWidth(['step-dev', 'step-qa'], UNDATED, ['depends']));
    expect(screen.getByText(new RegExp(`≥\\s*${quoted}px`))).toBeInTheDocument();
    // Proof: `hiddenColumnIds` not passed through to `foldedTableMinWidth`,
    // this failed on `expected "vi.fn" to be called with arguments: [ [ 'step-
    // dev', 'step-qa' ], …, [ 'depends' ] ]`. Watched, 2026-08-28.
  });

  itDom('says nothing on this panel that reads Phase or Role', () => {
    // The panel's own surface. What it is *called* is the settings modal's tab,
    // asserted in `project-settings-modal.test.tsx` — this panel renders no
    // title of its own since `project-config-modal` split it out of the dialog
    // it used to be. `Phase` was the word on every control here until
    // `steps-not-phases`, and `Role` was the same thing below.
    stubbed();

    const drawn = document.body.textContent;
    expect(drawn).not.toMatch(/phase|role/i);
    // Non-vacuous: the panel really drew its controls, so an empty match is a
    // reading rather than an empty page.
    expect(screen.getByRole('button', { name: 'Remove Dev' })).toBeDefined();
    expect(drawn).toContain('Dev');
  });

  itDom('lists every step, each with a way to rename it and remove it', () => {
    stubbed();

    expect(screen.getByLabelText('Dev')).toHaveProperty('value', 'Dev');
    expect(screen.getByLabelText('QA')).toHaveProperty('value', 'QA');
    expect(screen.getByRole('button', { name: 'Remove Dev' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove QA' })).toBeDefined();
  });

  itDom('adds a step and rereads the project', async () => {
    const stub = stubbed();

    type('New step', 'Design');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await settle();

    expect(stub.addStep).toHaveBeenCalledWith('Design');
    // The reread is what puts the column on the table. Without it the panel
    // would be the only thing on the page that knew about the new step.
    expect(stub.onChanged).toHaveBeenCalled();
  });

  itDom('renames a step to what was typed over it', async () => {
    const stub = stubbed();

    type('QA', 'Review');
    fireEvent.submit(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameStep).toHaveBeenCalledWith('step-qa', 'Review');
  });

  itDom('renames on the way out of the box, not only on Enter', async () => {
    // Every other text field in this product commits on blur. This one took
    // Enter and nothing else, so a rename typed and then abandoned — ✕, Tab,
    // anything — was dropped without a PATCH, a toast or a mark on the field,
    // and `onOpenChange` clearing `renamed` is what made it silent. Observed on
    // 2026-08-09.
    //
    // Proof: the `onBlur` handler removed from the rename box, this failed on
    // `expected "spy" to be called with arguments: [ 'step-qa', 'Review' ]` —
    // never called at all, and so did `keeps a rename that was typed and then
    // the dialog closed on it`. Both watched, 2026-08-09.
    const stub = stubbed();

    type('QA', 'Review');
    fireEvent.blur(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameStep).toHaveBeenCalledWith('step-qa', 'Review');
  });

  itDom('keeps a rename that was typed and then left for the modal’s ✕', async () => {
    // The gesture the finding was filed for: type over the name, then reach for
    // the ✕. A browser blurs the field before the click lands — jsdom performs
    // no focus change of its own, so the blur is delivered here in the order a
    // browser delivers it. The ✕ itself is the modal's now and is not on this
    // panel; what this panel owes is that the blur alone carries the rename,
    // and that the modal is told it is in flight so the ✕ cannot close over it.
    const stub = stubbed();

    const box = screen.getByLabelText('QA');
    box.focus();
    type('QA', 'Review');
    fireEvent.blur(box);
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(true);
    await settle();

    expect(stub.renameStep).toHaveBeenCalledWith('step-qa', 'Review');
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  itDom('sends nothing on the way out of a box nobody typed in', async () => {
    // The other half, and what keeps the blur commit from being a rename on
    // every click through the list: leaving a box unchanged is not an edit.
    const stub = stubbed();

    fireEvent.blur(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameStep).not.toHaveBeenCalled();
  });

  itDom('sends nothing for a name that is only spaces', async () => {
    const stub = stubbed();

    type('New step', '   ');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await settle();

    // Refused here rather than by be-01: the answer is the same and this one
    // needs no round trip.
    // Proof: the `clean === ''` guard removed, this failed on `expected "spy"
    // to not be called at all, but it was called 1 time`. Watched, 2026-08-09.
    expect(stub.addStep).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A step needs a name.');
  });

  itDom('sends nothing when a name is submitted unchanged', async () => {
    const stub = stubbed();

    fireEvent.submit(screen.getByLabelText('QA'));
    await settle();

    expect(stub.renameStep).not.toHaveBeenCalled();
  });

  itDom('says what refused it, in words rather than in be-01’s code', async () => {
    const stub = stubbed({ addStep: vi.fn(() => Promise.reject(new Error('taken'))) });

    type('New step', 'Dev');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await settle();

    expect(screen.getByRole('alert').textContent).toBe('That name is already a step on this plan.');
    expect(document.body.textContent).not.toContain('taken');
    expect(stub.onChanged).not.toHaveBeenCalled();
  });
});

describe('how far a dependency reaches', () => {
  const WHOLE = 'The whole work item';
  const ANCHOR = 'The first estimated step';

  itDom('the reach is chosen and written', async () => {
    // Two options and a sentence each, in the section about the steps — a
    // dependency's reach is a statement about how steps chain. The project's
    // stored value is what is checked; picking the other one writes it and
    // re-reads the plan, because every date on the table may move on it.
    //
    // Proof: the `setDepReach(...)` call dropped from the handler — the choice
    // left as a rendered radio nobody wrote — and this failed on
    // `expected "spy" to be called with arguments: [ 'anchor-slice' ] /
    // Received: / Number of calls: 0`, taking the two cases below with it.
    // Watched 2026-08-29.
    const { setDepReach, onChanged } = stubbed();

    expect(screen.getByRole('radio', { name: new RegExp(WHOLE) })).toBeChecked();
    expect(screen.getByRole('radio', { name: new RegExp(ANCHOR) })).not.toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(ANCHOR) }));

    expect(setDepReach).toHaveBeenCalledWith('anchor-slice');
    // After the write, not beside it: the plan is re-read because the reach
    // decided every date in it.
    await settle();
    expect(onChanged).toHaveBeenCalled();
  });

  itDom('shows the project’s own reach, not the one it was last shown', () => {
    // The dialog holds nothing about the reach: what is checked is be-01's
    // answer, arriving as a prop, exactly as the step names beside it do.
    stubbed({ depReach: 'anchor-slice' });

    expect(screen.getByRole('radio', { name: new RegExp(ANCHOR) })).toBeChecked();
    expect(screen.getByRole('radio', { name: new RegExp(WHOLE) })).not.toBeChecked();
  });

  itDom('does not move the choice while the write is still in flight', () => {
    // The window the fault lives in. A dialog that kept the choice in a
    // `useState` of its own would tick the other option the instant it was
    // clicked and go on showing it whatever be-01 said — so the assertion is
    // made **while the request is unanswered**, which is the only moment an
    // optimistic dialog and a patient one look different.
    //
    // Proof: a local `useState` mirror added, set in the handler before the
    // request and read by `checked` — and this failed on
    // `expect(element).toBeChecked() / Received element is not checked:
    // <input checked="" class="mt-1" name="dep-reach" type="radio" …`, the
    // whole-item option unticked against a project be-01 had not answered for.
    // Watched 2026-08-29.
    const held = vi.fn(() => new Promise<void>(() => undefined));
    stubbed({ setDepReach: held });

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(ANCHOR) }));

    expect(held).toHaveBeenCalledWith('anchor-slice');
    expect(screen.getByRole('radio', { name: new RegExp(WHOLE) })).toBeChecked();
    expect(screen.getByRole('radio', { name: new RegExp(ANCHOR) })).not.toBeChecked();
  });

  itDom('says what a refused reach was refused for, on the surface', async () => {
    // The dialog's own rule: refusals are sentences on this surface rather
    // than codes in a toast over the page it covers.
    stubbed({ setDepReach: vi.fn(() => Promise.reject(new Error('forbidden'))) });

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(ANCHOR) }));
    await settle();

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

/*
  `describe('leaving the surface')` stood here on `dep-reach-whole-item` and is
  deliberately not carried over: its two cases — the focus returning to the
  trigger, and a walked-away-from confirmation being dropped — are about the
  shell, and `project-config-modal` made the shell `ProjectSettingsModal`'s.
  Both live in `project-settings-modal.test.tsx` now, the second restated as a
  refusal (the modal will not close over an unanswered confirmation) rather
  than as a silent clear.
*/

describe('the chord on the surface', () => {
  itDom('submits the form the keystroke was aimed at', async () => {
    const stub = stubbed();

    type('New step', 'Design');
    // The chord `F shadcn-foundation`'s second round made reachable: the first
    // version of `usePageShortcutsSuspended` ended it in the capture step and
    // this handler could never have run.
    // Proof: `onChord` returning early for every keystroke, this failed on
    // `expected "spy" to be called with arguments: [ 'Design' ]`. Watched,
    // 2026-08-09.
    fireEvent.keyDown(screen.getByLabelText('New step'), {
      key: 'Enter',
      metaKey: true,
      code: 'Enter',
    });
    await settle();

    expect(stub.addStep).toHaveBeenCalledWith('Design');
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

    expect(stub.renameStep).toHaveBeenCalledWith('step-qa', 'Review');
    expect(stub.addStep).not.toHaveBeenCalled();
  });

  itDom('leaves a bare Enter to the form it is in', async () => {
    // Not a chord at all — `commandChord` answers null — so nothing here claims
    // it and the browser's own submit does the work.
    // Proof: `onChord` widened to fire on any `Enter`, this failed on `expected
    // "spy" to not be called at all, but actually been called 1 times`.
    // Watched, 2026-08-09.
    const stub = stubbed();

    type('New step', 'Design');
    fireEvent.keyDown(screen.getByLabelText('New step'), { key: 'Enter', code: 'Enter' });
    await settle();

    expect(stub.addStep).not.toHaveBeenCalled();
  });
});

describe('removing a step', () => {
  const IN_USE: StepUsage = {
    estimates: 2,
    actuals: 0,
    progress: 0,
    measures: 0,
    assignments: 1,
    assumedAssignees: [{ workItemId: 'w2', assumedNow: null, assumedAfter: 'p1' }],
  };
  const refusing = () =>
    vi.fn((_stepId: string, cascade: boolean) =>
      cascade
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ ok: false, reason: 'in_use' as const, inUse: IN_USE }),
    );

  itDom('asks without a cascade first, and shows what would go', async () => {
    const removeStep = refusing();
    stubbed({ removeStep });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();

    expect(removeStep).toHaveBeenCalledWith('step-qa', false);
    expect(document.body.textContent).toContain(
      'Removing the step QA would delete 2 estimates and 1 assignment.',
    );
    // The flip, by the work item's **number**: an id in a confirmation is a
    // fact nobody reading the plan can act on.
    expect(document.body.textContent).toContain(
      '020: nobody is assumed to be doing all of it now, Kat would be afterwards.',
    );
  });

  itDom('sends nothing when the confirmation is agreed to without the box', async () => {
    const removeStep = refusing();
    stubbed({ removeStep });

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

    expect(removeStep).toHaveBeenCalledTimes(1);
  });

  itDom('removes it once the box is ticked', async () => {
    const removeStep = refusing();
    const stub = stubbed({ removeStep });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    fireEvent.click(screen.getByLabelText('Delete them along with the step'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();

    expect(removeStep.mock.calls).toEqual([
      ['step-qa', false],
      ['step-qa', true],
    ]);
    expect(stub.onChanged).toHaveBeenCalled();
  });

  itDom('keeps the step, and asks nothing more, when the confirmation is dropped', async () => {
    const removeStep = refusing();
    stubbed({ removeStep });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Keep QA' }));
    await settle();

    expect(removeStep).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('New step')).toBeDefined();
  });

  itDom('takes a step nobody uses without asking at all', async () => {
    // be-01 removes one nothing points at outright, so there is nothing to
    // confirm — and asking anyway is how people learn to confirm without
    // reading.
    const stub = stubbed();

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await waitFor(() => {
      expect(stub.onChanged).toHaveBeenCalled();
    });

    expect(screen.queryByLabelText('Delete them along with the step')).toBeNull();
  });
});

describe('how wide the steps make the table', () => {
  itDom('says the width, from the table’s own columns', () => {
    stubbed({ steps: [DEV, QA] });

    // 855px of fixed columns on a plan nobody has dated, 200 for Name, 96 each
    // for two folded steps (827 → 839 → 879 in `number-column-widen` and then
    // `external-refs`, and 879 → 855 on 2026-08-31 when `depends` paid for that
    // column, 110 → 86). That was 1247 against the 1248px frame a 1280 laptop
    // gives it — one pixel inside. Contextual Links then removed its 40px from
    // the initial layout (1247 → 1207), and the narrower drag column removes
    // the current 8px (1207 → 1199). Renderer-neutral wording: this dialog
    // opens from the phone's toolbar sheet too, and the sentence used to
    // describe a table that reader has never seen.
    expect(document.body.textContent).toContain(
      '2 steps need ≥1199px of width to sit side by side',
    );
    expect(document.body.textContent).toContain(
      'under 768px wide or 500px tall the plan is drawn as cards instead',
    );
    expect(document.body.textContent).not.toContain('before the table scrolls sideways');
  });

  itDom('quotes the table’s own arithmetic, not a sum of its own', () => {
    // The number moves with every width the table declares, including the ones
    // that depend on the plan: the same two steps are 28px wider once
    // somebody sets an earliest start anywhere in the project.
    //
    // Proof: `minWidth` in `steps-panel.tsx` replaced by the hand-written
    // `952 + steps.length * 96` this sentence used to quote, this failed on
    // `expected '…≥1144px…' to contain '≥1123px'` for the undated plan and on
    // `≥1151px` for the dated one — one number where the table lays out two.
    // Watched, 2026-08-09, when those two figures were the table's; they were
    // 1219 and 1247 since `priority-column`, 1231 and 1259 since
    // `number-column-widen`, 1271 and 1299 for the hours `external-refs` sat
    // unpaid for, and 1247 and 1275 since 2026-08-31 — the assertions below
    // read them from the layout rather than repeating them.
    cleanup();
    stubbed({ steps: [DEV, QA], frameState: UNDATED });
    expect(document.body.textContent).toContain(
      `≥${String(foldedTableMinWidth(['step-dev', 'step-qa'], UNDATED))}px`,
    );

    cleanup();
    stubbed({ steps: [DEV, QA], frameState: DATED });
    expect(document.body.textContent).toContain(
      `≥${String(foldedTableMinWidth(['step-dev', 'step-qa'], DATED))}px`,
    );
    expect(
      foldedTableMinWidth(['step-dev', 'step-qa'], DATED) -
        foldedTableMinWidth(['step-dev', 'step-qa'], UNDATED),
    ).toBe(28);
  });

  itDom('resolves the project’s own step ids, not stand-ins for the count', () => {
    // A width can be resolved per column id now, which is what makes an id a
    // fact rather than a placeholder: `T1 column-widths-drag` stores a
    // reader's override under the exact column id, and a `step0-final`
    // invented here could never carry one. The two resolve to the same 96 px
    // today, so nothing measurable tells them apart — the call is what says
    // which was asked about.
    //
    // Proof: `steps.map((step) => step.id)` replaced by the
    // `Array.from({ length: steps.length }, (_, at) => \`step${at}\`)` this
    // used to be, this failed on `expected [ 'step0', 'step1' ] to deeply
    // equal [ 'step-dev', 'step-qa' ]`. Watched, 2026-08-09.
    stubbed({ steps: [DEV, QA] });

    expect(vi.mocked(foldedTableMinWidth).mock.calls.at(-1)?.[0]).toEqual(['step-dev', 'step-qa']);
  });

  itDom('quotes a step’s dragged width, because it resolved that step’s own column', () => {
    // The half of "real ids, not stand-ins" that has a number attached to it.
    // A reader who drags the Dev column wider is looking at a wider table, and
    // the figure that says how much width the steps need has to be that
    // table's. It can only be, because the override is stored under
    // `step-dev-final` — the id the table renders that column by — and this
    // panel resolves the project's own step ids.
    //
    // Proof: `steps.map((step) => step.id)` replaced by the stand-in
    // `Array.from({ length: steps.length }, (_, at) => \`step${at}\`)`, this
    // failed on `expected 'StepsStepsThe steps every work ite…' to contain
    // '≥1167px'` — the dialog, as it then was,
    // quoting the default 96px column while the table lays out the dragged
    // 140px one. Watched, 2026-08-09.
    const dragged: FrameLayoutState = {
      hasAnyNotBefore: false,
      columnWidthOverrides: new Map([['step-dev-final', 140]]),
    };
    stubbed({ steps: [DEV, QA], frameState: dragged });

    const quoted = foldedTableMinWidth(['step-dev', 'step-qa'], dragged);
    expect(document.body.textContent).toContain(`≥${String(quoted)}px`);
    // And it really moved: a figure that ignored the override would be the
    // undated default, which is what a stand-in id resolves to.
    expect(quoted).toBe(foldedTableMinWidth(['step-dev', 'step-qa'], UNDATED) + (140 - 96));
  });

  itDom('counts one step as one, and says so in the singular throughout', () => {
    // The noun and the **verb**. This asserted `'1 step need'` until
    // 2026-08-14: it was written about `count`'s singular noun and swept the
    // plural verb beside it up in the same `toContain`, so the sentence a
    // single-step plan really showed — `1 step need ≥1123px` — was pinned by
    // the test that was meant to be checking it. The whole clause is asserted
    // now, which is the only spelling that can see the verb.
    //
    // Proof: the verb put back to a flat `need`, this failed on
    // `expected 'StepsStepsThe steps every work ite…' to contain
    // '1 step needs ≥1123px of width to sit…'`. Watched on h2puni, 2026-08-14 (fault F5).
    stubbed({ steps: [DEV] });

    // 1123 → 1135 → 1175 in `number-column-widen` (93 → 105 in
    // `COLUMN_WIDTHS`) and then `external-refs` (the 40px `refs` column), and
    // 1175 → 1151 on 2026-08-31 when `depends` paid for it (110 → 86),
    // then 1151 → 1111 when Links joined the initial hide-list and 1111 →
    // 1103 when the drag column narrowed by 8px.
    expect(document.body.textContent).toContain('1 step needs ≥1103px of width to sit side by');
    expect(document.body.textContent).not.toContain('1 step need ≥');
  });

  itDom('keeps the plural where there is more than one step', () => {
    // The other arm, and it is here so the fix above cannot be "never say
    // `need`" — a singular-only expression satisfies the test above and reads
    // `2 steps needs` on every real plan.
    //
    // Proof: the plural arm made to say `needs` as well, this failed on
    // `expected 'StepsStepsThe steps every work ite…' to contain
    // '2 steps need ≥1219px of width to sit…'`. Watched on h2puni, 2026-08-14 (fault F6).
    stubbed({ steps: [DEV, QA] });

    // 1219 → 1231 → 1271 in `number-column-widen` (93 → 105 in
    // `COLUMN_WIDTHS`) and then `external-refs` (the 40px `refs` column), and
    // 1271 → 1247 on 2026-08-31 when `depends` paid for it (110 → 86),
    // then 1247 → 1207 when Links joined the initial hide-list and 1207 →
    // 1199 when the drag column narrowed by 8px.
    expect(document.body.textContent).toContain('2 steps need ≥1199px of width to sit side by');
    expect(document.body.textContent).not.toContain('2 steps needs');
  });
});

describe('what the section tells the modal it is holding', () => {
  itDom('is clean on mount and dirty from a name typed into the new box', () => {
    // `project-config-modal` D3: a name typed and not added is an edit a close
    // would lose, so the modal is told.
    const stub = stubbed();
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(false);

    type('New step', 'Design');

    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  itDom('is dirty while a confirmation is open and clean once it is answered', async () => {
    // A confirmation nobody has answered is exactly the thing the modal must
    // not close over: the ✕ used to clear it silently.
    const removeStep = vi.fn((_stepId: string, cascade: boolean) =>
      cascade
        ? Promise.resolve({ ok: true })
        : Promise.resolve({
            ok: false,
            reason: 'in_use' as const,
            inUse: { estimates: 1, assignments: 0, assumedAssignees: [] },
          }),
    );
    const stub = stubbed({ removeStep });

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    await settle();
    expect(screen.getByLabelText('Delete them along with the step')).toBeDefined();
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Keep QA' }));
    await settle();
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  itDom('reads a name typed back to what it was as clean', () => {
    // The rename box is a draft only while it says something the step does
    // not. Typed to `Review` and back to `QA`, it holds nothing — and a modal
    // that refused to close over it would be refusing over a box that says
    // exactly what be-01 says.
    const stub = stubbed();

    type('QA', 'Review');
    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(true);
    type('QA', 'QA');
    fireEvent.blur(screen.getByLabelText('QA'));

    expect(stub.onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(stub.renameStep).not.toHaveBeenCalled();
  });
});

describe('the sentences on their own', () => {
  it('the removal sentence says step', () => {
    // A project names its own steps, so one may well be called `Kat` or
    // `Backend` — the sentence somebody agrees to before a removal has to say
    // what kind of thing is going, in the word every other face uses for it.
    const sentence = usageSentence('QA', {
      estimates: 2,
      actuals: 0,
      progress: 0,
      measures: 0,
      assignments: 1,
      assumedAssignees: [],
    });

    expect(sentence).toContain('the step QA');
    expect(sentence).not.toMatch(/phase|role/i);
  });

  it('names both counts, even the one that is zero', () => {
    expect(
      usageSentence('QA', {
        estimates: 1,
        actuals: 0,
        progress: 0,
        measures: 0,
        assignments: 0,
        assumedAssignees: [],
      }),
    ).toBe('Removing the step QA would delete 1 estimate and 0 assignments.');
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
