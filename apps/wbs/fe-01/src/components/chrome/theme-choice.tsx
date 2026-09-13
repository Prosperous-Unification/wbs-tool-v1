import type { KeyboardEvent } from 'react';

import { THEME_CHOICES, type ThemeChoice } from '@/lib/theme';

/** What each answer is called on screen. Sentence case, like the rest of the chrome. */
const WORDS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * What the menu lends each of its items: the roving tab stop, the ref it
 * focuses through, and the keyboard the whole menu shares.
 *
 * A factory rather than three props per item, because the menu owns the
 * navigation and this component owns the markup, and the seam between them is
 * "which item am I" — one number.
 */
export interface MenuItemProps {
  ref: (element: HTMLButtonElement | null) => void;
  tabIndex: number;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /**
   * Tells the menu which item really holds the focus, whatever moved it there.
   *
   * Declared here rather than left to the spread, because the seam is the whole
   * of what these three props are: an item that took this list's markup and not
   * this line would be one the arrows compute from the wrong index after a
   * mouse click. `AccountMenu` has the account of the fault.
   */
  onFocus: () => void;
}

export interface ThemeChoiceItemsProps {
  choice: ThemeChoice;
  onChoose: (choice: ThemeChoice) => void;
  /** @param at This item's place in the menu's own flat list. */
  itemProps: (at: number) => MenuItemProps;
  /** Where this group starts in that list — everything before it belongs to the menu. */
  firstAt: number;
}

/**
 * The palette, as three answers in one row of the account menu.
 *
 * **`menuitemradio` and not three `menuitem`s**, because these are one answer
 * with three values rather than three things to do: a screen reader that is
 * told "Dark, radio button, not checked" has been told what the other two are
 * for, and one told "Dark, menu item" has been told nothing at all. The
 * `role="group"` around them is what carries the name of the question — a menu
 * whose children are radios needs somewhere to say what they are radios about.
 *
 * **One row, not three lines.** The menu it sits in holds a single action, and
 * a palette switch that took four lines of it would make the way out of the app
 * the small print. Three words at `text-xs` fit inside the menu's own `min-w-40`
 * with room to spare, which is the width the trigger already claims.
 *
 * **Choosing does not close the menu**, which parts from the item below it and
 * from `ActionsMenu`. The whole feedback for this control is the page changing
 * colour underneath it, and a menu that vanished at the same moment would take
 * the comparison — and the way back — off the screen with it. `Log out` closes,
 * because there is nothing left to compare.
 *
 * The keys are the menu's, not this component's: `Up`/`Down`/`Left`/`Right`,
 * `Escape` and `Tab` are all handled by `AccountMenu`'s one handler, lent here
 * through {@link ThemeChoiceItemsProps.itemProps}. `Enter` and `Space` are the
 * browser's own click on a `<button>`, which lands on `onClick` below — and the
 * menu's handler is what takes a **modified** one away first, which is R5 #14:
 * a guard that returns without `preventDefault` leaves the browser to fire the
 * click it just refused.
 */
export function ThemeChoiceItems({
  choice,
  onChoose,
  itemProps,
  firstAt,
}: ThemeChoiceItemsProps): React.JSX.Element {
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-1 px-2 py-1">
      <span aria-hidden="true" className="text-muted-foreground mr-auto text-xs">
        Theme
      </span>
      {THEME_CHOICES.map((offered, at) => (
        <button
          key={offered}
          type="button"
          role="menuitemradio"
          aria-checked={offered === choice}
          {...itemProps(firstAt + at)}
          // `bg-transparent` is not decoration and not a duplicate of the
          // reset: it is what keeps the chosen answer's fill from being undone
          // by nothing. The unchosen two take the same class from `bg-accent`'s
          // absence, and saying it here keeps all three reading as one control.
          className={
            offered === choice
              ? 'bg-accent text-accent-foreground cursor-pointer rounded-sm border px-2 py-0.5 text-xs'
              : 'hover:bg-accent hover:text-accent-foreground text-muted-foreground cursor-pointer rounded-sm border border-transparent bg-transparent px-2 py-0.5 text-xs'
          }
          onClick={() => {
            onChoose(offered);
          }}
        >
          {WORDS[offered]}
        </button>
      ))}
    </div>
  );
}
