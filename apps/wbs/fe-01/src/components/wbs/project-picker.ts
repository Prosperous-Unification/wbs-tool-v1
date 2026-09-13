import { shortInstant, shortIsoDate } from './short-date';

/**
 * A project as the picker **matches** it: a name, and the id it selects.
 *
 * Two fields, though the entries handed in carry more — a `ProjectListEntry`
 * also holds the owner's name and the day it was made, and the entry meta puts
 * both on screen. They are shown and never searched: typing an owner's
 * username must not conjure a project whose name says nothing of the sort, or
 * the box stops being a name box and nobody is told. Widening this interface is
 * the change that would let that in, which is why the rule is stated on the
 * type rather than only in the filter below.
 */
export interface PickableProject {
  id: string;
  name: string;
}

/**
 * The parenthetical an entry carries after its name: `(kat · 1 Jun)`.
 *
 * `createdAt` is an **epoch millisecond**, which is why this asks
 * {@link shortInstant} and not {@link shortIsoDate}. The two are chosen by the
 * type of the value rather than by the surface: a project's start date and the
 * table's Start, End and Not before cells are zone-free calendar days, and
 * printing one through the other is how a plan reads a day early west of
 * Greenwich, or a moment lands on the wrong side of midnight.
 *
 * One function so the shown text and the hover title cannot drift: the entry is
 * truncated on screen, and a `title` saying something else is worse than no
 * title at all.
 */
export function entryMeta(
  entry: { ownerName: string; createdAt: number },
  now: Date = new Date(),
): string {
  return `(${entry.ownerName} · ${shortInstant(entry.createdAt, now)})`;
}

/**
 * The moments a hover card needs from an entry to print its meta rows.
 *
 * Structural rather than {@link PickableProject} on purpose: the card is
 * placed by the page that owns the full {@link ProjectListEntry}, and naming
 * only the fields it reads is the same honesty the list type already applies
 * to be-01's wire. Every field is already on the wire — `startDate` included —
 * so the card costs no new request, which is the whole of the "immediately"
 * requirement.
 */
export interface ProjectCardSource {
  ownerName: string;
  /** An epoch millisecond, chosen because it is a moment and not a calendar day. */
  createdAt: number;
  /** `YYYY-MM-DD`, or null while the plan is not on a calendar. */
  startDate: string | null;
  /** An epoch millisecond, or null for a project the account has never opened. */
  lastOpenedAt: number | null;
}

/**
 * The rows a hover card prints for a project: ownership, start day, and when
 * the account last opened it.
 *
 * One function so the card and its test cannot drift, and so the two formatter
 * choices stay in one place: `createdAt` and `lastOpenedAt` are moments
 * ({@link shortInstant}), `startDate` is a zone-free calendar day
 * ({@link shortIsoDate}). The labels live here rather than in the card's
 * markup so the unit test is the card's content, not its chrome.
 */
export interface ProjectCardMeta {
  /** `(kat · 1 Jun)` — the entry meta, never truncated on the card. */
  ownership: string;
  /** `Start 12 Mar`, or `Not scheduled` while the project is off the calendar. */
  start: string;
  /** `Last opened 20 Aug`, or `Never opened`. */
  lastOpened: string;
}

/**
 * The card's meta rows from one entry, in this account's own "today".
 */
export function projectCardMeta(entry: ProjectCardSource, now: Date): ProjectCardMeta {
  return {
    ownership: entryMeta(entry, now),
    start:
      entry.startDate === null ? 'Not scheduled' : `Start ${shortIsoDate(entry.startDate, now)}`,
    lastOpened:
      entry.lastOpenedAt === null
        ? 'Never opened'
        : `Last opened ${shortInstant(entry.lastOpenedAt, now)}`,
  };
}

/**
 * The projects the picker may offer, narrowed by what was typed.
 *
 * A case-insensitive substring over the name, the same rule the Depends on
 * picker uses — two pickers side by side that filter differently is a surprise
 * with nothing to gain from it.
 *
 * **Order is the order given, always.** be-01 answers in this account's own
 * order — opened first by recency, then never-opened by creation — and that is
 * the whole point of the change: re-sorting here, even by "best match", would
 * be a second ordering rule quietly overruling the one the server computed.
 */
export function matchingProjects<T extends PickableProject>(
  projects: readonly T[],
  typed: string,
): T[] {
  const wanted = typed.trim().toLowerCase();
  if (wanted === '') return [...projects];
  // The name and nothing else.
  //
  // Proof: widened to `|| project.ownerName.toLowerCase().includes(wanted)`
  // — with `ownerName` added to {@link PickableProject} to allow it — `never
  // matches an owner, however plainly the entry shows one` failed on
  // `expected [ { id: 'p2', …(3) } ] to deeply equal []`, and the page's own
  // `matches the name alone — an owner's username offers nothing` failed
  // beside it. Watched, 2026-08-09.
  return projects.filter((project) => project.name.toLowerCase().includes(wanted));
}
