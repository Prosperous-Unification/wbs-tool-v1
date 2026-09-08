import type { CellRef } from './cell-navigation';
import {
  aListIsOpenIn,
  type CellAttacher,
  type CellElement,
  cellIn,
  cellKey,
  focusedCellKey,
} from './editable-grid';

/**
 * What became of an edit a cell sent.
 *
 * `refused` covers everything that left be-01 without the edit — a 4xx, a
 * dropped connection, a request that never went out. They are one event to a
 * cell: the only copy of what was typed is the one on screen.
 *
 * `unsent` is the commit that asked be-01 for nothing, and it is not the same
 * answer. A composite cell whose two texts differ only in their line endings
 * sends no patch; an estimate cell holds a half-typed trio as a draft it
 * renders from. Neither has anything for a face to hold back or to correct,
 * and calling either of them `landed` would be recording a write.
 */
export type CommitOutcome = 'landed' | 'refused' | 'unsent';

/** The answer a commit that sent nothing gives, as a settled promise. */
export const unsent = (): Promise<CommitOutcome> => Promise.resolve('unsent');

/**
 * Sends what a cell holds and answers what be-01 did with it.
 *
 * @param typed What the box holds now.
 * @param baseline What it was showing when this typing began — {@link LiveField}'s
 * held value, which is *not* the same as the current server value whenever a
 * peer's edit arrived mid-word and was held back. A cell that edits more than
 * one field at once (the Name cell holds the notes under the name) must diff
 * against this rather than against the row it renders from, or the field the
 * local user never touched reads as one they emptied.
 */
export type SendEdit = (typed: string, baseline: string) => Promise<CommitOutcome>;

/**
 * The last submission a field made, and what it was diffed against (rule 5).
 *
 * The baseline is half of it because it is what makes the record expire by
 * itself: once a refetch has moved the held value, the same text typed again is
 * a different edit and is sent.
 *
 * `landing` is the third field because a flush is not only a blur. A chord that
 * flushes a cell whose blur is still out has to be given **that** request's
 * answer, not a settled `unsent`: `unsent` reads as "nothing is happening
 * here", and the chord would create a row or move the focus while a patch that
 * may yet be refused is in the air.
 *
 * Rule 5 dedupes; it does not serialize. Only *this* record is dropped when the
 * request it names comes back without landing, and a second, different text
 * typed into the same cell while the first is still out is a genuinely new
 * edit that goes out beside it. Which of the two answers first is be-01's
 * business — a refusal systematically overtakes a landing, because a landing
 * refetches the tree before it resolves and a refusal does not. What keeps the
 * loser from writing its answer over the winner's is
 * {@link LiveField.submissions}.
 */
interface Submission {
  typed: string;
  baseline: string;
  landing: Promise<CommitOutcome>;
}

/**
 * Every draft be-01 refused, by the cell it was typed into — the one piece of
 * live-editing state that outlives the thing rendering it.
 *
 * Rule 4 used to hold a refusal in a ref inside `CellInput`, which is exactly as
 * long as that component lives — and two things unmount it. A step change
 * rebuilds every column (`columns` depends on `steps`, deliberately; see
 * `wbs-table.tsx`), and from `M mobile-cards` on, a phone turned sideways
 * swaps the whole renderer. Either way a name be-01 had refused was replaced by
 * the server's value and the only copy of what had been typed was gone.
 *
 * Here, therefore, keyed by the cell rather than by the node or by the face: the
 * node is what a remount replaces, and the face is what a breakpoint replaces. A
 * `Map` rather than a `WeakMap` for the same reason — a key that dies with the
 * element it was keyed by would die at the remount too.
 *
 * It holds **only** refusals, and each of them only until the person resolves it
 * — by leaving the cell again, which retries, or by putting the box back, which
 * abandons it. That is what keeps it from growing: nothing lands in here that
 * somebody is not still being asked about.
 */
const heldRefusals = new Map<string, string>();

/**
 * Every mounted cell's own "leave this cell now", by the node it belongs to.
 *
 * The keyboard needs it: Cmd+Enter and Ctrl+N have to send what is in the box
 * **before** they move the focus or create a row, and the only thing they hold
 * is `event.currentTarget`. Reaching it through the node rather than plumbing
 * a commit thunk down to each of the four cell classes is what keeps the
 * routing matrix's cells identical to each other — one call, whichever kind of
 * box the chord was pressed in.
 *
 * Keyed by the node and not by the cell, unlike {@link heldRefusals}, because
 * this one is a fact about a box that is on screen right now rather than about
 * the field: a flush with nothing rendered has nothing to flush. A `WeakMap`,
 * so a cell that unmounts takes its entry with it — a `Map` keyed by element is
 * a leak of every row anybody has ever scrolled past.
 */
const flushes = new WeakMap<CellElement, () => Promise<CommitOutcome>>();

/**
 * Forgets every held refusal whose cell `isGone` answers true for.
 *
 * Called when a step is removed: its columns no longer exist, so a draft held
 * for one is text nobody can ever resolve — it would sit in the map for the
 * life of the page, and be restored into a cell of some later step that
 * happened to be given the same column id.
 *
 * Only the durable copy goes. A field that is still mounted keeps `isRefused`,
 * and so keeps the text in the box until the remount that is on its way takes
 * the box with it: silently rewriting a box somebody is looking at is not what
 * "this step is gone" should look like, and the remount is what says it.
 *
 * @param isGone Asked about each held cell key (`rowId::columnId`).
 */
export function forgetRefusedDrafts(isGone: (cellKey: string) => boolean): void {
  for (const cellKey of [...heldRefusals.keys()]) {
    if (isGone(cellKey)) heldRefusals.delete(cellKey);
  }
}

/** What is held for this cell, for a test to read without reaching into the map. */
export function refusedDraftFor(cellKey: string): string | undefined {
  return heldRefusals.get(cellKey);
}

/**
 * Commits `node` exactly as leaving it would, and answers what be-01 did.
 *
 * `unsent` for a box no {@link LiveField} is rendered as — the date cell and the
 * pickers, which write on the change or on the pick and hold no draft between
 * keystrokes. That is a modeled state rather than an unknown: those boxes have
 * nothing to flush, and the chord that called this still has to run.
 *
 * @param node The box the chord was pressed in.
 * @returns What be-01 did with what was in it, once the request has settled.
 */
export function flushCell(node: CellElement): Promise<CommitOutcome> {
  return flushes.get(node)?.() ?? unsent();
}

/**
 * One editable field of the plan, and everything it knows between the server
 * and the box it is being typed into.
 *
 * This is the state a renderer mounts rather than owns. `CellInput` is its DOM
 * face today and `M mobile-cards` will be a second one; both construct a field
 * for the same `rowId::columnId` and both get back the draft be-01 refused,
 * because that half lives in {@link heldRefusals} and not in here.
 *
 * The obvious way to follow the server is `key={value}` on an input with a
 * `defaultValue` — a new key, a new node, and the new value is picked up
 * because the old node is gone. That shipped, and it meant a peer editing the
 * field you are typing in unmounted your input mid-word and dropped the focus
 * to the body. Every edit refetches the whole tree (see `WbsTable`), so that is
 * not a rare collision: it is what happens whenever two people work on one row.
 *
 * So the node is kept and its `value` is assigned directly instead. Five rules,
 * and the fourth is the one worth reading twice:
 *
 * 1. A new server value is written into the node, not rendered — no remount, no
 *    lost focus, no lost caret.
 * 2. Nothing is written while the person is typing in this cell. Their word wins
 *    until they leave it, and their own blur is what resolves the disagreement.
 * 3. A blur sends only what actually differs from the value this cell was last
 *    showing. Clicking through a row writes nothing.
 * 4. A draft be-01 **refused** is held against every later refetch, focus or no
 *    focus, and against the unmounting of whatever was rendering it. Rule 2 only
 *    holds while the cell has the focus, and a refusal arrives after the blur
 *    that caused it — so without this the only copy of the typed text sits in
 *    the DOM waiting for the next peer edit, or the next breakpoint, to erase it.
 * 5. The same text is not sent twice against the same baseline. `shown` stays
 *    on the old value until the refetch lands, so a second focus-and-leave
 *    inside that window looks exactly like a fresh edit to rule 3 — and one
 *    gesture would become two journal entries and two Cmd+Zs. Two *different*
 *    texts in that window are two edits and both go out; {@link submissions}
 *    is what stops the slower answer writing over the faster one.
 *
 * **What a new face inherits, and what it does not.** The held refusal, and
 * only that. `shown`, `typed`, `sent` and `latest` are re-derived from the
 * server value the new face was given, which is what the component's refs did
 * when they died with it — carrying them across a remount would change rule 5
 * and rule 2 in ways nothing here tests, and `openspec/changes/
 * live-editing-extraction/verify.md` records the choice rather than making it
 * silently.
 */
export class LiveField {
  /** The box this field is rendered as, or null before the face has attached one. */
  private node: CellElement | null = null;
  /** The value that node is currently showing, as far as this field knows. */
  private shown: string;
  /** Whether anyone has typed here since {@link shown} and the node last agreed. */
  private typedHere = false;
  /** The newest server value, readable from a blur handler as well as an effect. */
  private latest: string;
  /**
   * Whether the box holds text be-01 was asked for and refused (rule 4).
   *
   * Not {@link typedHere}: that one is only consulted while the cell has the
   * focus, and by the time a refusal comes back the focus has gone — leaving it
   * the only thing standing between a person's two typed fields and the next
   * refetch would be leaving nothing there at all.
   *
   * Distinct from the entry in {@link heldRefusals} on purpose. That one is the
   * copy that outlives the face; this one is whether the box on screen is
   * showing it, and {@link forgetRefusedDrafts} clears the first without
   * touching the second.
   */
  private refused = false;
  private sent: Submission | null = null;
  /**
   * How many commits this field has sent, so a commit can tell whether it is
   * still the newest one when its answer finally arrives.
   *
   * Two patches for one cell are in the air whenever somebody types, leaves,
   * clicks back in, types something else and leaves again inside one round
   * trip — {@link Submission} says why rule 5 lets that happen — and they come
   * back out of order more often than not. Only the newest may write: an older
   * answer that still wrote would either clear a newer refusal's hold (the
   * box and {@link heldRefusals} both revert to the text be-01 turned down)
   * or install its own stale text as a hold over an edit that landed, which
   * the next render puts back on screen, {@link sync} then freezes against
   * peers, and the next blur sends again.
   *
   * A superseded answer is still *returned* — `flushCell`'s caller asked what
   * became of the edit it flushed and that is unchanged by a later one — it
   * simply touches none of this field's state.
   *
   * The same shape as `refresh`'s generation guard in `wbs-table.tsx`, for the
   * same reason: a read and a write both have a newest, and out-of-order
   * completion is the normal case rather than the edge.
   */
  private submissions = 0;

  /**
   * Sends what this field holds. Reassigned by the face on **every render**,
   * deliberately.
   *
   * The closure is rebuilt each render — it reads the row this cell belongs to —
   * and an effect would publish the new one a render late. A chord can be
   * pressed in that window, and it would commit against the row before last.
   */
  send: SendEdit = () => unsent();

  /**
   * What the face does once this field has written the node: the Name cell
   * grows to fit the text it has just been given.
   *
   * Called wherever the server's value reaches the box, and that is **three**
   * places rather than the two it looks like: {@link serverSaid}, the landing
   * in {@link submit}, and {@link leave}'s "nothing was typed" path, which
   * applies whatever rules 2 and 4 had been holding back while the focus was
   * here. The box is not already the height of that text — a peer's edit that
   * arrived mid-visit is written into the node by that path, after the face's
   * blur handler has already measured the box against the older, shorter one.
   */
  afterSync: (node: CellElement | null) => void = () => undefined;

  constructor(
    readonly cellKey: string,
    value: string,
  ) {
    this.shown = value;
    this.latest = value;
  }

  /**
   * Attaches the box this field is rendered as, and puts back whatever refusal
   * the cell was left holding.
   *
   * The second half is rule 4 across a face that has gone. A step change
   * rebuilds every column definition and React unmounts every cell — the one
   * sanctioned remount this table has — and a phone turned sideways will swap
   * the renderer outright; either way the fresh node arrives showing the
   * server's value. The typed text be-01 refused exists nowhere else, so it is
   * put back and {@link refused} is raised again, which is what stops the next
   * sync writing over it.
   *
   * {@link shown} is deliberately left at the server's value: it is the baseline
   * this cell was showing when the typing started, be-01 refused the edit so the
   * server still holds it, and leaving this cell again is therefore a retry
   * rather than a no-op.
   *
   * Proof: the restore deleted, `keeps a draft be-01 refused when a new step
   * rebuilds every column` failed on `expected '' to be 'Strip the wiring'` —
   * the typed name replaced by the server's, by a step somebody else added.
   * Watched, 2026-08-09.
   */
  takeNode(node: CellElement | null): void {
    this.node = node;
    if (node === null) return;
    flushes.set(node, () => this.leave());
    const held = heldRefusals.get(this.cellKey);
    if (held !== undefined && node.value !== held) {
      node.value = held;
      this.refused = true;
      this.typedHere = false;
    }
  }

  /** One keystroke in this field's box. */
  tookAKeystroke(): void {
    this.typedHere = true;
  }

  /**
   * The server's value for this field, from a render that carried a fresh tree.
   *
   * Rules 1, 2 and 4 decide together whether it reaches the box.
   */
  serverSaid(value: string): void {
    this.latest = value;
    this.sync();
    // After the sync, not before: the height has to follow the value the node
    // is actually showing, and a peer's edit arrives through the sync rather
    // than through any keystroke of ours.
    this.afterSync(this.node);
  }

  /**
   * Writes the newest server value into the box, unless something is holding it
   * back.
   */
  private sync(): void {
    const node = this.node;
    if (node === null || this.latest === this.shown) return;
    // Rule 4, before rule 2 and without asking where the focus is: a refused
    // draft is unsaved text that exists nowhere else, and the refusal landed
    // after the blur that sent it. It is held until the person resolves it
    // themselves — by leaving the cell again, which retries it, or by putting
    // the box back to what it was showing, which abandons it.
    // Proof: deleted, `keeps a refused draft on screen when the next refetch
    // arrives` failed on `expected 'Rewire the shed\nmeasure twice' to be
    // 'Strip the wiring\nmeasure twice, cut …'`. Watched, 2026-08-08.
    if (this.refused) return;
    // Rule 2. `document.activeElement` rather than a focus/blur flag of our own:
    // the question is only ever asked about right now, and the DOM already knows
    // the answer without a second copy of it to keep in step.
    if (this.typedHere && node === document.activeElement) return;
    node.value = this.latest;
    this.shown = this.latest;
    this.typedHere = false;
  }

  /**
   * What leaving this cell means.
   *
   * Rule 3: only a value that actually differs from what this cell was last
   * showing is sent. Clicking through a row writes nothing. Rule 5 narrows
   * that further — the same text against the same baseline is a resubmission
   * of a request that is already out — and what the commit answers decides
   * whether rule 4 holds what is in the box from here on.
   *
   * The outcome is returned as well as acted on, because a blur is no longer
   * the only caller: Cmd+Enter and Ctrl+N flush the cell through
   * {@link flushCell} and have to know whether be-01 took it before they move
   * the focus or create a row. Rule 5 is what keeps that from doubling the
   * request — the blur the focus move causes arrives at a cell whose `shown`
   * has not advanced, sees its own submission recorded, and sends nothing.
   */
  leave(): Promise<CommitOutcome> {
    const node = this.node;
    if (node === null) return unsent();
    // Cleared before either branch: it means "typed since `shown` and the node
    // last agreed", and leaving it set would have the *next* visit to this cell
    // hold back a peer's edit on the strength of typing that happened before
    // the focus ever left.
    this.typedHere = false;
    if (node.value !== this.shown) return this.submit(node.value);
    // Nothing typed, or typed back to what it already said — so there is no
    // unsaved draft left to hold, and anything rule 2 or rule 4 held back
    // while the focus was here is safe to apply now.
    this.refused = false;
    heldRefusals.delete(this.cellKey);
    this.sync();
    // After the sync, exactly as {@link serverSaid} does it, and for a reason
    // that is this path's alone: the face measures the box on the blur and the
    // blur runs *before* this, so a peer's name that rule 2 held back all the
    // while the focus was here would be written into a box sized for the name
    // it replaced — clipped by the Name cell's `overflow: hidden` if it is
    // longer, dead height under it if it is shorter.
    // Proof: this line removed, `a peer's longer name arriving while the cell
    // is focused is whole once it is left` failed on `a line of the peer's
    // name is hidden after the blur — Expected: < 0.5, Received: 1.979…`.
    // Watched in Chromium, 2026-08-09.
    this.afterSync(this.node);
    return unsent();
  }

  /** The half of {@link leave} that has something to send. */
  private submit(text: string): Promise<CommitOutcome> {
    // Rule 5. `shown` has not moved since the last submission, so this is
    // that submission again — the person clicked back into the cell and out
    // of it while the request was still out, and be-01 has already been
    // asked for exactly this. **The answer is the request's own**, so a
    // chord that flushed this cell waits for what be-01 does with it rather
    // than reading a settled `unsent` as permission to move.
    // Proof, two faults, both watched 2026-08-08. This branch deleted:
    // `sends one request however often the cell is left before it lands`
    // failed on `expected [ [ 'w1', { …(2) } ], …(1) ] to have a length of 1
    // but got 2`. The `return` narrowed back to `unsent()`: `a chord waits
    // for the blur’s patch that is still out, and a refusal makes nothing`
    // failed on `expected [ 'patch', 'create' ] to deeply equal [ 'patch' ]`
    // — a row created against a request nobody had heard back from.
    if (this.sent?.typed === text && this.sent.baseline === this.shown) return this.sent.landing;
    // The refusal this submission supersedes, dropped **synchronously** and
    // before anything is sent. Typing over a refused draft and being refused
    // again is one gesture with a window in the middle of it: the commit
    // raises the toast that says why, React flushes that discrete update
    // inside this blur — before any microtask — and {@link takeNode} runs
    // against the ref callback the render rebuilt, finds the *previous*
    // draft still held, and writes it into a box holding the newer one. The
    // second refusal then lands a round trip later and records the right
    // text under a box already showing the wrong one, where `sync` cannot
    // correct it because rule 4 is holding.
    //
    // Observed live on dev, 2026-08-11: `urgent` typed over a refused
    // `1e999` blurred back to `1e999`. Proof: this line removed, `shows the
    // draft just refused, not the one refused before it` failed on
    // `expected '1e999' to be 'urgent'`. Watched, 2026-08-11.
    //
    // What this deliberately does not do is put `text` here in its place.
    // The map is the copy that survives the face, and a draft still in the
    // air is not yet a refusal: holding it would have a remount restore it
    // with {@link refused} raised over an edit that then lands, freezing the
    // cell against the next peer edit. The window it leaves — a remount
    // between this line and the answer — loses the draft rather than
    // restoring a stale one, which is the trade this change chose.
    heldRefusals.delete(this.cellKey);
    // No `sync()` afterwards: `shown` is deliberately left holding the old
    // value until the refetch this commit triggers comes back. Advancing it
    // here would be recording a write that has not happened yet, and a failed
    // request would then have nothing left to correct the cell from.
    //
    // `shown` is handed over as the baseline for the same reason it is
    // compared against here: it is what this box was showing when the typing
    // started, which a peer's edit held back by rule 2 has deliberately not
    // moved. A composite cell diffs its fields against it. Read before the
    // request goes out: the node's value a round trip later is whatever has
    // been typed since, and what a refusal has to hold is what was refused.
    const baseline = this.shown;
    const generation = ++this.submissions;
    const landing = this.send(text, baseline).then((outcome) => {
      // Only the newest commit for this cell may write what it heard back.
      // Read before anything below it, and before `outcome` is acted on at
      // all: every line after this point is state a newer commit has already
      // decided, and this one is a round trip out of date.
      // Proof, two faults, both watched 2026-08-09 with this line deleted.
      // `an older landing does not clear the refusal that overtook it` failed
      // on `expected undefined to be 'Gamma'` — the hold on the text be-01
      // had just turned down, dropped by the answer to the edit before it.
      // `an older refusal does not hold its text over the edit that landed`
      // failed on `expected 'Beta' to be 'Gamma'` — the landed name replaced
      // on the very next render by the one be-01 had refused, and sent again
      // by the blur after that.
      if (generation !== this.submissions) return outcome;
      if (outcome !== 'landed') {
        // Nothing of this edit is on the server — `refused` was turned down,
        // `unsent` never went — so the record of a submission goes with it
        // and leaving the cell again is a fresh ask rather than a duplicate.
        // Proof: this line removed, `sends a refused edit again when the
        // cell is left a second time` failed on `expected [] to deeply equal
        // [ [ 'w1', { …(2) } ] ]` — the retry dropped as a duplicate of a
        // request that never landed. Watched, 2026-08-08.
        this.sent = null;
        // Held outside this field as well as in it, because this object dies
        // with the face and a step change — or a breakpoint — takes the face
        // away. `text` rather than the node's value: this runs a round trip
        // later, and what was refused is what was sent.
        // Proof: this write removed, `an editor that left the row window can
        // commit, escape, and hold a refusal` failed after the refused priority
        // remounted on `Expected: "0" · Received: "50"`. Watched in Chromium,
        // 2026-09-08.
        if (outcome === 'refused') heldRefusals.set(this.cellKey, text);
        // Rule 4, and only for the refusal: an `unsent` commit is one where
        // the box and be-01 already agree, so there is no draft to hold.
        // Proof: this line removed, `keeps a refused draft on screen when
        // the next refetch arrives` failed on the same assertion the gate in
        // `sync` answers for — a refusal nothing records is a refusal
        // nothing can hold. Watched, 2026-08-08.
        this.refused = outcome === 'refused';
        return outcome;
      }
      this.refused = false;
      heldRefusals.delete(this.cellKey);
      // The refetch this commit triggered lands *before* it resolves, so a
      // draft that rule 4 held back was held back through the one render
      // that carried its answer. Nothing else would come.
      this.sync();
      this.afterSync(this.node);
      return outcome;
    });
    // Recorded synchronously, before any continuation above can run: the
    // record is what a flush arriving in the meantime is answered from, and
    // the `sent = null` a refusal performs is a microtask away at the earliest.
    this.sent = { typed: text, baseline, landing };
    return landing;
  }
}

/**
 * Where a structural edit has asked the focus to go once the refetched tree is
 * on screen, and whether it is still entitled to go there.
 *
 * A cell **and a column**, because a row moved from an estimate box has to come
 * back under the same box. Creating and deleting rows name the Name column,
 * because that is where typing continues.
 *
 * Two consumers, one rule between them. The Name cell claims its own arrival as
 * it attaches ({@link landOnAttached}), which is the only way to win the race a
 * newly created row has; every other column is landed on from the committed DOM
 * once the tree that holds it is rendered ({@link land}). Both ask the same
 * question first, and it is the interesting one — see {@link isStale}.
 *
 * Here rather than in `WbsTable` because a card renderer has the same problem:
 * a create is a request and a refetch, and something has to put the caret back
 * in the row that arrived.
 */
export class FocusIntent {
  private wanted: CellRef | null = null;
  /**
   * The cell the command now running was issued from, or null when it came
   * from a button rather than from the grid.
   *
   * Written by {@link commandIssued} at the synchronous moment the gesture
   * happened — not where {@link wants} is called, because that happens once the
   * request has been answered, which is the far side of the window this exists
   * to measure.
   */
  private issuedFrom: string | null = null;

  /** Records where the command about to run was issued from. */
  commandIssued(): void {
    this.issuedFrom = focusedCellKey();
  }

  /** Asks for the focus to land in `cell`, or drops a pending intent with null. */
  wants(cell: CellRef | null): void {
    this.wanted = cell;
  }

  /**
   * Whether the pending intent has been overtaken by the person using the
   * grid, and so must not fire.
   *
   * A structural edit is a request and a refetch, and the reader is free to do
   * something else in between. Two of those somethings make the focus move a
   * theft rather than a service, and both were observed on 2026-08-09: the
   * caret was pulled out of a folded cell with an open `@` list mid-burst, the
   * list closed with it, and the keys still coming landed in an ordinary cell
   * and made a row.
   *
   * - **A list is open.** Whatever it is attached to, it owns the keyboard
   *   until Escape gives it back, and moving the focus closes it.
   * - **The focus is in a different cell from the one the command came from.**
   *   That is the fact that separates the wanted steals from this one: after
   *   Ctrl+N, Alt+N, Cmd+Enter, Duplicate or Delete the reader is still in the
   *   cell they pressed it in — or on the ⋯ button, which is no cell at all
   *   and reads as "leave it alone", not as "somewhere else".
   *
   * Conservative on purpose: with nothing focused, or the focus already in the
   * cell the intent names, the intent stands.
   */
  private isStale(wanted: CellRef, grid: HTMLElement | null): boolean {
    if (grid !== null && aListIsOpenIn(grid)) return true;
    const standingIn = focusedCellKey();
    if (standingIn === null || standingIn === this.issuedFrom) return false;
    return standingIn !== cellKey(wanted.rowId, wanted.columnId);
  }

  /**
   * Lands the focus on the cell the intent names, once the tree that holds it
   * is on screen.
   *
   * Read from the committed DOM rather than from the render that asked for it:
   * a move is a request and a refetch, and the row it names does not exist in
   * the renderer's DOM until the refetched tree renders. A browser drops the
   * focus when React reorders the rows — the node is detached and reinserted —
   * so this is what puts it back, in the column the person was working in.
   *
   * The intent is cleared only once the cell is actually found. A refresh from
   * somebody else's edit can land between the request and its own refetch, and
   * clearing on that render would drop the focus on the floor rather than
   * carrying it to the tree that arrives next.
   */
  land(grid: HTMLElement | null, attach?: CellAttacher): void {
    const wanted = this.wanted;
    if (wanted === null || grid === null) return;
    // Cancelled rather than left pending: the reader has moved on, so this
    // intent is not waiting for a tree that has yet to arrive — it is over.
    // Proof: this dropped here and in {@link landOnAttached}, `a late create
    // does not take the focus back off a cell somebody moved to` failed on
    // `expected <textarea …> to be <input …>`. Watched, 2026-08-09.
    if (this.isStale(wanted, grid)) {
      this.wanted = null;
      return;
    }
    const arrived = cellIn(grid, wanted);
    if (arrived === undefined) {
      if (attach?.(wanted, 'focus') === true) this.wanted = null;
      return;
    }
    this.wanted = null;
    // Proof: left as a lookup that focuses nothing, both `lands in the same
    // column…` tests failed with the focus on the body. That is only visible
    // because those tests drop the focus first, the way a browser does — jsdom
    // keeps it on a node React moves, so without that the check could not fail.
    // Watched, 2026-08-06.
    arrived.focus();
  }

  /**
   * Lands the focus on a box that is attaching right now, when the intent names
   * exactly its cell.
   *
   * The Name cell's arrival, and the reason it cannot wait for {@link land}:
   * this runs during the commit that brings the row in, so it wins the race
   * against the effect — and a later render arriving before the row does would
   * otherwise take the focus with it. Enter-Enter-Enter depends on not losing
   * that race.
   *
   * The staleness question is asked here as well as there for the same reason:
   * winning the race means this would land the focus before the effect could
   * refuse it.
   */
  landOnAttached(node: CellElement, cell: CellRef, grid: HTMLElement | null): void {
    const wanted = this.wanted;
    if (wanted?.rowId !== cell.rowId || wanted.columnId !== cell.columnId) return;
    if (this.isStale(wanted, grid)) {
      this.wanted = null;
      return;
    }
    this.wanted = null;
    node.focus();
  }
}
