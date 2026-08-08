/**
 * Where a binding applies, which is also how the cheat sheet is grouped.
 *
 * `Editing` is the keys pressed while typing in a cell. Backspace fires in a
 * Name cell only — which is the box a work item's notes are written in as
 * well, under the first line, since it took over the Notes column's job; Tab
 * moves from every cell, and the arrows from the cells that are typed into — a
 * picker or a date box keeps its own arrows and is left by Tab. What Tab or
 * Backspace does at the very start of a name is the restructuring half: the
 * one place the keystroke has no text meaning.
 *
 * The Ctrl chords are in `Editing` too, and the reason is worth stating: they
 * fire from **any** cell, but only from a cell. They are not `Anywhere`, which
 * is the page — the sheet, the search box, the toolbar — and a reader looking
 * for what a chord does while typing would not find them there.
 *
 * `Moving rows` is the Alt chords, which work from any cell and any caret
 * position. The order here is the order the sheet is read in.
 */
export type Where = 'Editing' | 'Moving rows' | 'Estimates' | 'Pickers' | 'Anywhere';

export const WHERE_ORDER: readonly Where[] = [
  'Editing',
  'Moving rows',
  'Estimates',
  'Pickers',
  'Anywhere',
];

/** One key or chord, what it does, and where it applies. */
export interface KeyBinding {
  /** The chord as it is shown. `Alt` is a token — {@link showKeys} labels it per platform. */
  keys: string;
  does: string;
  where: Where;
}

/**
 * Every key this table answers to, held once.
 *
 * This is the only prose description of the keyboard in the app: the cheat
 * sheet renders it and nothing else re-states it, so the sheet cannot drift
 * from the registry. What keeps the *registry* from drifting from the code is
 * the cross-check in `keyboard-cheat-sheet.test.tsx` — every entry there names
 * the behaviour tests that prove it, and the check fails when a named test
 * leaves `wbs-table.test.tsx`. Read that file's `PROVEN_BY` before adding an
 * entry here; an entry with no test named for it fails the check.
 *
 * `(where, keys)` is unique, because that pair is the key the mapping is by.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    keys: 'Enter',
    does: 'A new line in the name — which is where a work item’s notes are written, under the first line. It used to make a new work item; that is Ctrl + N now.',
    where: 'Editing',
  },
  {
    keys: 'Ctrl/⌘ + Enter',
    does: 'Saves what is in this cell and moves to the next row’s name — or, on the last row of the plan, makes a new work item there and lands in it. A save the server refuses leaves the caret where it is and makes nothing.',
    where: 'Editing',
  },
  {
    keys: 'Ctrl + N / Alt + N',
    does: 'A new work item below this one, at the same level, ready to be typed into — from any cell and any caret position, not only at the end of the plan. Two chords for one thing because Chrome keeps Ctrl + N for itself except on a Mac.',
    where: 'Editing',
  },
  {
    keys: 'Ctrl + H / J / K / L',
    does: 'Left, down, up and right between cells — where the fingers are, and without the arrows’ rule that the text comes first. The way out of a long note in one press.',
    where: 'Editing',
  },
  {
    keys: 'Ctrl + D, twice',
    does: 'Deletes this work item, and its children move up to take its place. The first press tints the row and says what the second one will do; anything else at all — another key, leaving the cell, three seconds — calls it off, and a row whose number is frozen refuses. Ctrl/⌘ + Z puts it back.',
    where: 'Editing',
  },
  {
    keys: 'Tab',
    does: 'The next field, from any cell, and on into the next row at the end of one. Past the last field in the table it leaves the grid, onto that last row’s ⋯ menu. In the name, at the very start, it still indents the row under the one above it.',
    where: 'Editing',
  },
  {
    keys: 'Shift + Tab',
    does: 'The previous field. In the name, at the very start, it outdents the row instead.',
    where: 'Editing',
  },
  {
    keys: 'Backspace',
    does: 'At the very start of a name, outdents the row — and on a wholly empty top-level row, one with no note under the name either, removes it and leaves the focus on the row above.',
    where: 'Editing',
  },
  {
    keys: '↑ ↓ ← →',
    does: 'Move between cells: up and down walk a column, left and right move on once the caret has run out of text. In the name — which holds the note under it — up and down move the caret first, and leave the row only from the very start and the very end.',
    where: 'Editing',
  },
  {
    keys: 'Alt + ↑ / Alt + ↓',
    does: 'Moves the row up or down among its siblings. It never changes what the row sits under, and it stops at either end of the group.',
    where: 'Moving rows',
  },
  {
    keys: 'Alt + →',
    does: 'Indents the row — from any cell and any caret position, where Tab needs the start of the name.',
    where: 'Moving rows',
  },
  {
    keys: 'Alt + ←',
    does: 'Outdents the row, from any cell.',
    where: 'Moving rows',
  },
  {
    keys: '2/3/8',
    does: 'In a folded role’s cell: optimistic, realistic and pessimistic in one go.',
    where: 'Estimates',
  },
  {
    keys: '5',
    does: 'One number means all three points are that number.',
    where: 'Estimates',
  },
  {
    keys: 'Empty it',
    does: 'Emptying a folded role’s cell clears the estimate it held.',
    where: 'Estimates',
  },
  {
    keys: 'Type',
    does: 'Searches the list. Depends on takes a number or a name; the assignee and team boxes take a name.',
    where: 'Pickers',
  },
  {
    keys: '@',
    does: 'In a folded role’s cell, looks somebody up to do the work: type @ and the name. Enter takes the first one offered, or adds a contributor nobody had. On its own, @ offers to take the current one off. What is typed in front of the @ stays the estimate — 2/3/8@kat is one gesture.',
    where: 'Pickers',
  },
  {
    keys: '↑ ↓',
    does: 'Move the highlight in the Depends on list, stepping over the rows it would refuse.',
    where: 'Pickers',
  },
  {
    keys: 'Enter',
    does: 'Takes the highlighted entry. In an assignee or team box — which has no highlight — it takes the first match, or adds what you typed when nothing matches it.',
    where: 'Pickers',
  },
  {
    keys: 'Escape',
    does: 'Closes the list, leaving the box as it was.',
    where: 'Pickers',
  },
  {
    keys: '010, 020',
    does: 'Depends on takes several numbers at once, separated by commas or spaces.',
    where: 'Pickers',
  },
  {
    keys: '?',
    does: 'Opens this sheet — from anywhere except a box you are typing in, where it stays a question mark.',
    where: 'Anywhere',
  },
  {
    keys: 'Escape',
    does: 'Closes this sheet. In the Find box, clears the search and puts your collapsed branches back.',
    where: 'Anywhere',
  },
  {
    keys: 'Ctrl/⌘ + Z',
    does: 'Undoes your last change to this plan — but only when nothing it touched has been changed since, and it says whose change stopped it when something has. Not inside a box you are typing in: there, undo is the browser’s.',
    where: 'Anywhere',
  },
  {
    keys: 'Ctrl/⌘ + Shift + Z',
    does: 'Puts back what you last undid, under exactly the same condition. Making any other change of your own clears what there was to put back.',
    where: 'Anywhere',
  },
];

/** The keystroke fields a binding predicate judges, so it needs no DOM event. */
export interface KeyPress {
  key: string;
  /**
   * Where the key sits on the board, independent of what it types.
   *
   * Optional because most of this file's predicates judge the character and
   * nothing else. {@link commandChord} is the exception and the reason this
   * field exists at all: macOS turns Alt+N into a dead key, so `key` arrives
   * as `Dead` and there is no letter in the event to match on.
   */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

/**
 * Whether the person is typing into `target` rather than at the page.
 *
 * The guard is the event's **target**, not the focus: a keystroke on its way
 * into a text box is the one thing a page-level shortcut must never take, and
 * the target is what says which box that is.
 */
export function isTypingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  // The property is what a browser computes, including inherited editability;
  // jsdom leaves it undefined, so the attribute is read beside it. In a
  // browser the two agree on an element that carries the attribute itself.
  return target.isContentEditable || target.getAttribute('contenteditable') === 'true';
}

/** Which way along the undo stack a keystroke asks to go, or null for neither. */
export type StackDirection = 'undo' | 'redo';

/**
 * Whether this keystroke is the undo or the redo chord, and which.
 *
 * **Never inside an editable element, and that is the whole rule.** A browser
 * has its own undo for text somebody is typing, it is better than anything
 * this table could offer for a half-typed word, and a shortcut that took
 * Cmd+Z away from an input would lose keystrokes that never reached be-01 at
 * all. Blur first: the table's undo walks back through changes that have
 * landed, and nothing in a box has landed yet. Stated rather than guessed at —
 * see `openspec/changes/conditional-undo/design.md`.
 *
 * `Ctrl` and `Meta` are both accepted rather than detected. Chrome on Linux
 * sends Ctrl, Safari sends Meta, and a browser that sends both is asking for
 * the same thing either way; guessing the platform to reject one of them
 * would refuse the chord on whichever keyboard the guess got wrong.
 *
 * Proof: the `isTypingInto` guard removed, `leaves ctrl-z alone inside a name
 * cell, where the browser owns it` failed with the table's own undo running
 * over a half-typed name. Watched, 2026-08-07.
 *
 * @param pressed The keystroke, as much of it as this decision needs.
 * @param target What the keystroke was aimed at — `event.target`, not the focus.
 * @returns `undo`, `redo`, or null when this is somebody else's keystroke.
 */
export function undoChord(pressed: KeyPress, target: EventTarget | null): StackDirection | null {
  // `Z` arrives uppercase when Shift is held, which is exactly the redo chord.
  if (pressed.key !== 'z' && pressed.key !== 'Z') return null;
  if (!pressed.ctrlKey && !pressed.metaKey) return null;
  if (pressed.altKey) return null;
  if (isTypingInto(target)) return null;
  return pressed.shiftKey === true ? 'redo' : 'undo';
}

/**
 * What one command chord asks the table for.
 *
 * Four of them are motion between cells and read as compass directions rather
 * than as the letters that produce them: `h j k l` is where the fingers are,
 * left-down-up-right is what it means, and a handler switching on `'h'` would
 * be a second place that has to know the mnemonic.
 */
export type Command = 'left' | 'down' | 'up' | 'right' | 'new-item' | 'next-or-create' | 'delete';

/**
 * Which direction one of the four motion letters is, or null for any other key.
 *
 * A function rather than a lookup record, for `altMoveFor`'s reason in
 * `wbs-table.tsx`: indexing a record by an arbitrary `event.key` is the
 * unchecked access `noUncheckedIndexedAccess` exists to stop.
 */
function motionFor(key: string): Command | null {
  switch (key) {
    case 'h':
      return 'left';
    case 'j':
      return 'down';
    case 'k':
      return 'up';
    case 'l':
      return 'right';
    default:
      return null;
  }
}

/**
 * Which command a keystroke is, or null when it is somebody else's.
 *
 * **The Ctrl family, and why it is not the Cmd family.** Chromium reserves
 * File→New on macOS and Apple's HIG owns Cmd+H for Hide, so Cmd+N and Cmd+H
 * never reach page JS at all — `chromium.googlesource.com`,
 * `docs/mac/about_hotkeys_and_keycodes.md`. Dany chose Ctrl knowing the trade
 * it makes: Ctrl+H/D/K/N shadow macOS's emacs-style text edits inside our
 * cells. The guardrails are that nothing here destroys anything in one
 * gesture (Ctrl+D arms and must be confirmed) and that every one of these is
 * undoable. Not re-litigated here — see the change's proposal.
 *
 * **Alt+N is the same command's second chord**, because Ctrl+N is equally
 * reserved on Windows and Linux Chrome. It is matched on {@link KeyPress.code}
 * rather than on the letter: macOS turns Alt+N into a dead key and delivers
 * `key: 'Dead'` with no letter in it, so a predicate reading `key` would bind
 * the chord on exactly the platforms that do not need it.
 *
 * Shift is rejected outright and Alt is rejected on everything but its own
 * chord. A predicate loose about the extra modifiers is one that answers for
 * chords it was never given — Ctrl+Shift+Z is redo, and the row moves are
 * Alt+arrow.
 *
 * `metaKey` is rejected rather than accepted-as-well, which is the opposite of
 * {@link undoChord}'s rule and the difference is the point: undo is one action
 * two platforms spell differently, and these are chords one platform has
 * already taken. On Linux `Meta` is the Windows key, and a Ctrl-or-Meta rule
 * would fire a create off a keystroke aimed at the window manager.
 *
 * @param pressed The keystroke, as much of it as this decision needs.
 * @returns The command, or null when this is not one.
 */
export function commandChord(pressed: KeyPress): Command | null {
  if (pressed.shiftKey === true) return null;
  if (pressed.key === 'Enter') {
    if (pressed.altKey) return null;
    return pressed.ctrlKey || pressed.metaKey ? 'next-or-create' : null;
  }
  // Alt's own chord, before the Ctrl family: the two never combine, and the
  // physical key is all this branch may read.
  if (pressed.altKey) {
    if (pressed.ctrlKey || pressed.metaKey) return null;
    return pressed.code === 'KeyN' ? 'new-item' : null;
  }
  if (!pressed.ctrlKey || pressed.metaKey) return null;
  if (pressed.key === 'n') return 'new-item';
  if (pressed.key === 'd') return 'delete';
  return motionFor(pressed.key);
}

/**
 * A keyboard event, as much of one as {@link commandChordIn} reads.
 *
 * Structural rather than React's own type, so this file still needs no
 * component library to judge a keystroke — and `code` is under `nativeEvent`
 * because that is where a React synthetic event carries the physical key that
 * Alt+N is matched on.
 */
export interface KeyPressEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  nativeEvent: { code: string };
}

/**
 * {@link commandChord}, read straight off a keyboard event.
 *
 * The same six fields in the same order at four call sites was four chances to
 * leave one of them out — and a `shiftKey` that never arrives makes the
 * predicate answer for chords it was not given.
 *
 * @param event The keystroke, as a React keyboard event delivers it.
 * @returns The command, or null when this is not one.
 */
export function commandChordIn(event: KeyPressEvent): Command | null {
  return commandChord({
    key: event.key,
    code: event.nativeEvent.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
}

/**
 * Which label the `Alt` key should be given, or `unsure` when nothing said.
 *
 * `unsure` is a third answer rather than a default to one of the other two: a
 * sheet that says `⌥` to a Windows reader is wrong in a way that is hard to
 * recover from, and one that says `⌥/Alt` is merely wordy. Every reader can
 * read their own keyboard.
 */
export type AltStyle = 'mac' | 'pc' | 'unsure';

const MAC = /\b(mac|iphone|ipad|ipod)/i;
const NOT_MAC = /\b(win|linux|android|cros|x11|freebsd|openbsd)/i;

/**
 * Reads a platform out of what `navigator` says, if it says anything.
 *
 * Both arguments are optional because both can be absent: `navigator.platform`
 * is deprecated and empty in some browsers, and neither string is trusted to
 * exist. A runtime that reports neither gets `unsure`, which is a rendered
 * answer rather than a guess.
 *
 * @param platform What `navigator.platform` said, or undefined where it said nothing.
 * @param userAgent What `navigator.userAgent` said, or undefined.
 * @returns Which label {@link showKeys} should use for `Alt`.
 */
export function altStyleOf(platform: string | undefined, userAgent: string | undefined): AltStyle {
  const said = `${platform ?? ''} ${userAgent ?? ''}`;
  if (MAC.test(said)) return 'mac';
  if (NOT_MAC.test(said)) return 'pc';
  return 'unsure';
}

const ALT_LABEL: Readonly<Record<AltStyle, string>> = {
  mac: '⌥',
  pc: 'Alt',
  unsure: '⌥/Alt',
};

/**
 * One binding's chord, with `Alt` labelled for the keyboard in front of the
 * reader.
 *
 * A whole-word replacement: `Alt` is the only token that differs between
 * platforms here, and the arrows, Tab, Enter and the typed examples are the
 * same on both.
 *
 * @param keys A binding's `keys` string.
 * @param style What {@link altStyleOf} made of the browser.
 * @returns The chord as it should be shown.
 */
export function showKeys(keys: string, style: AltStyle): string {
  return keys.replaceAll(/\bAlt\b/g, ALT_LABEL[style]);
}
