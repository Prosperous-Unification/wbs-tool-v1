/**
 * One thing this browser remembers for its reader, read as a **claim**.
 *
 * Every entry in `localStorage` is user-editable and is read at a boundary, so
 * the stored bytes are validated once, here, and anything that is no longer a
 * `T` takes the key with it. `JSON.parse` and a type guard rather than a bare
 * string compare: the answers a browser can hold have to be told apart from the
 * strings that merely look like them, and every key here is written with
 * `JSON.stringify`, so it must be read with its inverse.
 *
 * Deliberately **not** the "unknown is not OK" throw. Every caller stores a
 * preference — a theme, a column width, a chart's height — and the alternative
 * is a page nobody can open until they clear storage by hand, over the colour
 * of a stripe. The refusal is the recovery: drop the key, answer `null`, and
 * the caller's own default stands.
 *
 * Eleven copies of this stood in four files until 2026-09-02, and they did not
 * all agree: {@link Remembered.read} against {@link Remembered.readAndDrop} was
 * `lib/theme.ts`'s distinction alone, and it is the one that matters in React —
 * see `readAndDrop`.
 */
/**
 * What storage holds for one key: a value, nothing at all, or something that is
 * no longer a `T`.
 *
 * Three states and not two, because one caller answers each of them
 * differently: the Gantt detail switch opens **on** for a plan with dependency
 * edges when nothing is stored, and **off** when a stored answer was refused —
 * a reader who once turned it off and then hand-edited the value has still said
 * something, and it is not "show me the arrows".
 */
export type Claim<T> = { status: 'held'; value: T } | { status: 'absent' | 'refused' };

export interface Remembered<T> {
  /** The three states, for the callers that answer `absent` and `refused` differently. */
  claim(): Claim<T>;
  /**
   * The stored value, or `null` when there is none to read — **writing
   * nothing**, which is what a React render is allowed to do.
   *
   * A lazy `useState` initialiser is a function React may call twice, and
   * StrictMode double-invokes it on purpose to surface exactly that, so it is
   * no place for the `removeItem` below. Nothing observable differs — the
   * removal is idempotent and only a corrupt value reaches it — which is why
   * this is a rule being kept rather than a defect being fixed.
   */
  read(): T | null;
  /**
   * The same read, **dropping** a key whose contents are no longer a `T`.
   *
   * The drop is the observable half of a refusal: without it the same corrupt
   * value is read again on every load, and a control that silently falls back
   * (a `<select>` lands on its first option) looks recovered while storage
   * still holds the answer nobody can use.
   */
  readAndDrop(): T | null;
  write(value: T): void;
  /**
   * Removes the key — never a default written over it.
   *
   * What the reader returns to is whatever the app resolves for them *now*, and
   * a snapshot stored here is that promise broken: a column whose default has
   * changed since the drag would come back to the old one.
   *
   * Present on every store, and **not** called for every store: expansion, the
   * Mermaid lane and the saved views are deliberately outside a Layout reset,
   * which is visible at the reset's own call site rather than in the shape of
   * this interface.
   */
  forget(): void;
}

/** Stored bytes parsed as they were written, or `undefined` when they will not parse. */
function parsedOrNothing(stored: string): unknown {
  try {
    const claimed: unknown = JSON.parse(stored);
    return claimed;
  } catch {
    // Nothing but this app writes these keys, so the only way here is a
    // hand-edited store. Recovered from by the caller rather than rethrown.
    return undefined;
  }
}

/**
 * The store for one key, judged by one guard.
 *
 * `isValid` carries the whole rule, including ranges: a height outside its
 * bounds is not a height, and refusing it here is what keeps a hand-edited
 * `1e999` off the screen (`Infinity` is above every ceiling exactly as
 * `-Infinity` is below every floor, and JSON has no `NaN` — the line that could
 * not fail, `T1 column-widths-drag`).
 *
 * Per-entry sanitising is **not** here and is the caller's: the width store
 * drops entries for columns this reader no longer has, and it must not write
 * the sanitised set back — a step that is only temporarily absent would lose
 * its width for good.
 */
export function remembered<T>(
  key: string,
  isValid: (claimed: unknown) => claimed is T,
): Remembered<T> {
  // A tagged shape rather than a sentinel value, because `refused` has to be
  // told apart from a stored value that legitimately *is* the string
  // `'refused'`: several of these stores hold a union of short strings.
  const claim = (): Claim<T> => {
    const stored = localStorage.getItem(key);
    if (stored === null) return { status: 'absent' };
    const claimed = parsedOrNothing(stored);
    return isValid(claimed) ? { status: 'held', value: claimed } : { status: 'refused' };
  };
  return {
    claim,
    read: () => {
      const claimed = claim();
      return claimed.status === 'held' ? claimed.value : null;
    },
    readAndDrop: () => {
      const claimed = claim();
      if (claimed.status === 'held') return claimed.value;
      if (claimed.status === 'refused') localStorage.removeItem(key);
      return null;
    },
    write: (value: T) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    forget: () => {
      localStorage.removeItem(key);
    },
  };
}

/**
 * The same store for a key written as **bare text** rather than as JSON.
 *
 * One caller stores a plain string — the settings modal's open section — and it
 * has to keep doing so: `remembered` would write `"teams"` with the quotes, and
 * every reader who has ever opened that modal would silently lose the tab they
 * were on the first time this shipped. The stored format is a compatibility
 * fact, not a style choice.
 *
 * `isValid` therefore judges the raw string, and there is no parse to fail:
 * absent and refused are the only two ways not to hold a value.
 */
export function rememberedText<T extends string>(
  key: string,
  isValid: (stored: string) => stored is T,
): Remembered<T> {
  const claim = (): Claim<T> => {
    const stored = localStorage.getItem(key);
    if (stored === null) return { status: 'absent' };
    return isValid(stored) ? { status: 'held', value: stored } : { status: 'refused' };
  };
  return {
    claim,
    read: () => {
      const claimed = claim();
      return claimed.status === 'held' ? claimed.value : null;
    },
    readAndDrop: () => {
      const claimed = claim();
      if (claimed.status === 'held') return claimed.value;
      if (claimed.status === 'refused') localStorage.removeItem(key);
      return null;
    },
    write: (value: T) => {
      localStorage.setItem(key, value);
    },
    forget: () => {
      localStorage.removeItem(key);
    },
  };
}
