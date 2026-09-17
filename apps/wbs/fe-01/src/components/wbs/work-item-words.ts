/**
 * A work item named the way the plan names it: its number, then its name.
 *
 * The number is what a person says out loud about a row — it is what the
 * Depends on chips carry, what the toasts name and what the keyboard's labels
 * are written from — and a chart of names alone made the two drawings of one
 * plan read as two plans. An unnamed row still has a number, which is the whole
 * of why the empty name has words of its own here.
 *
 * Dany, 2026-08-31: **"everywhere where the work item is referenced it is
 * referenced by its number and its title going together like `010 - heh hah`"**.
 * The Gantt's row labels had said it this way since `gantt-view`; this module is
 * that function moved out of the chart so the toasts, the cards, the modal
 * headings and the inherited-from sentences can say it too, rather than each
 * spelling the join for itself. Two of them already had — with a space, and with
 * a dash — which is exactly the drift a shared function ends.
 *
 * Proof: this reduced to `(number, _name) => number`, which is the spelling
 * every one of these places used before. **61 tests failed**, across the chart,
 * the cards and the table — among them `expected 'Waiting for 010, 020, 030' to
 * be 'Waiting for 010 - Strip, 020 - Sand, …'`, `expected '010020' to contain
 * '010 - Strip'` and `Unable to find role="tooltip" and name \`/^Start of 010 -
 * /\``. Watched 2026-09-01.
 */
export const rowWords = (number: string, name: string): string =>
  `${numberWords(number)}${nameWords(name)}`;

/**
 * The half of {@link rowWords} that is the plan's own numbering, and the half
 * that is the name — split because the Gantt's label **draws** the second half
 * through `InlineMarkdown` and still **says** the whole of it in its hint.
 *
 * Two halves of one sentence rather than two spellings of it: the hint and the
 * button are built from the same two functions, so a change to either reaches
 * both.
 */
export const numberWords = (number: string): string => `${number} - `;

/** A work item's name as the plan says it, which is words even when the name is empty. */
export const nameWords = (name: string): string => (name === '' ? '(unnamed)' : name);
