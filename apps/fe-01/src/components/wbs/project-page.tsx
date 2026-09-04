import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AppHeader } from '@/components/chrome/app-header';
import type { Roster } from '@/components/presence/presence-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { subscribeToProject } from '@/lib/project-stream';
import { cn } from '@/lib/utils';
import { httpProjectApi, type ProjectApi, type ProjectListEntry } from '@/lib/wbs-api';

import { useClosedByPointerOutside } from './close-on-outside-pointer';
import { type BesideAnchorRect, HoverCard } from './hover-card';
import { useRendererForViewport } from './plan-renderer';
import { entryMeta, matchingProjects, projectCardMeta } from './project-picker';
import {
  browserSavedPlansDeps,
  SavedPlansPanel,
  type SavedPlansPanelDeps,
} from './saved-plans-panel';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

export interface ProjectPageProps {
  token: string;
  /** Injected in tests; the app lets it default to the real one. */
  api?: ProjectApi;
  /**
   * The saved-plan shelf's wiring — injected in tests, the real one by default.
   *
   * A second override rather than a field on `api`, because the two answer
   * different halves of be-01: `ProjectApi` is the plan's routes and this is
   * the checkpoint routes, which a node may not have at all
   * ({@link SavedPlansPanelDeps}'s `available`). Merging them would make a
   * node without saved plans a `ProjectApi` that cannot be built.
   */
  savedPlansDeps?: SavedPlansPanelDeps;
  /**
   * Who else is in the project, for the right-hand end of the header bar.
   *
   * A function of the roster rather than the panel itself, because what the
   * panel needs — the session's own username — is the app's and not this
   * page's.
   *
   * **The roster is handed in, and it arrives on the table's own socket.** The
   * panel opened a second WebSocket per project until 2026-09-02; it is
   * presentational now, and this page owns the one stream both halves of the
   * screen are fed by. `users` is empty while no project is open, which is a
   * real state — a fresh account with nothing selected has no roster to be in —
   * and `connected` says whether the socket carrying it is up.
   */
  presence?: (roster: Roster) => ReactNode;
  /** The account menu, for the same reason and the same end of the bar. */
  account?: ReactNode;
  /** The two-page navigation, from router context — see `app-router.tsx`. */
  nav?: ReactNode;
}

/**
 * Where this browser remembers which project was open.
 *
 * localStorage, like the session token beside it: a refresh that forgets the
 * project costs a click and the remembering, every time. The stored id is a
 * claim, not a fact — it is honoured only while the fetched list still
 * contains it, so a deleted project cannot be "selected" into a 404.
 */
const PROJECT_KEY = 'wbs.project';

/**
 * The name be-01 writes for a project nobody has named yet.
 *
 * Named here rather than typed twice: it is both what the create route is
 * asked for and what the rename field opens holding, and two literals that
 * must agree is one of them going stale.
 */
const PLACEHOLDER_PROJECT_NAME = 'New project';

/**
 * Writes, or forgets, which project this browser was last in.
 *
 * Deliberately **not** through `lib/remembered.ts`, and this is the one store
 * that stays hand-written: its claim is judged against the project list this
 * load just fetched, not against a shape, so there is nothing to hand a guard
 * built once at module scope — `found.some(...)` is the whole validity rule and
 * it is different on every load. What it shares with the other ten is
 * `getItem`, `removeItem` and the reading that a disproved claim is dropped
 * rather than left to be re-offered; what it does not share is the part
 * `remembered` exists to hold.
 */
function rememberProject(id: string | null): void {
  if (id === null) localStorage.removeItem(PROJECT_KEY);
  else localStorage.setItem(PROJECT_KEY, id);
}

/**
 * Where an option's card opens: the **listbox's** own horizontal bounds, at
 * the option's row — or null while the option is scrolled out of the list.
 *
 * The list's edges rather than the option's, and that is the whole of the fix
 * this function carries. A card anchored to the option opens on top of the
 * list, so the card somebody opened to tell two projects apart covers the
 * other projects they were comparing it against. Moving it right by a constant
 * instead cannot work: the constant would have to be the list's width, which
 * varies with the longest project name.
 *
 * The option contributes its `top` and nothing else, which is what "the card
 * follows the pointer down the list and never across it" means.
 *
 * Proof: put back to the option's own rect under the old `anchor` placement —
 * `the open card leaves every option visible` failed on `the card opens at
 * 45px in a list ending at 240: expected 45 to be greater than or equal to
 * 240`, with the other three placement tests failing beside it. And with the
 * option's rect read through *this* placement (`left: box.left, right:
 * box.right`), `moving down the list does not move the card sideways` failed
 * on `expected '241px' to be '246px'` — the five pixels of border and padding
 * the option is inset by, which is the only difference a browser can show
 * between the two rectangles, since every option in a `w-full` list shares its
 * width. Watched 2026-08-29.
 */
function projectOptionAnchor(
  id: string | null,
  listbox: HTMLElement | null,
): BesideAnchorRect | null {
  if (id === null || listbox === null) return null;
  const option = document.getElementById(`project-option-${id}`);
  if (option === null) return null;
  const box = option.getBoundingClientRect();
  const list = listbox.getBoundingClientRect();
  if (box.bottom <= list.top || box.top >= list.bottom) return null;
  return { left: list.left, right: list.right, top: box.top };
}

/**
 * The portalled project preview, isolated so scroll remeasurement does not
 * rerender the page's table.
 */
function ProjectOptionCard({
  entry,
  now,
}: {
  entry: ProjectListEntry | undefined;
  now: Date;
}): ReactNode {
  const id = entry?.id ?? null;
  const [anchor, setAnchor] = useState<BesideAnchorRect | null>(null);
  useLayoutEffect(() => {
    const listbox = document.getElementById('project-options');
    const remeasure = () => {
      setAnchor(projectOptionAnchor(id, listbox));
    };
    remeasure();
    listbox?.addEventListener('scroll', remeasure);
    return () => {
      listbox?.removeEventListener('scroll', remeasure);
    };
  }, [id]);

  if (entry === undefined || anchor === null) return null;
  const meta = projectCardMeta(entry, now);
  return (
    <HoverCard beside={anchor} label={entry.name}>
      <div className="font-medium break-words">{entry.name}</div>
      <div className="text-muted-foreground">
        {meta.ownership}
        {entry.restricted ? ' · Restricted' : ''}
      </div>
      <div className="text-muted-foreground">{meta.start}</div>
      <div className="text-muted-foreground">{meta.lastOpened}</div>
    </HoverCard>
  );
}

/**
 * The box a project's new name is typed into while a rename is armed.
 *
 * A component rather than a callback ref on the picker's own `<Input>`, and
 * the reason is the selection: an inline callback ref is a new function on
 * every render, so React detaches and reattaches it on **every keystroke**,
 * and a `select()` there would put the whole draft back under the next
 * character typed. Mounting is the one moment a rename is armed, which is
 * exactly when the focus and the selection belong.
 *
 * Proof, both halves. With the `select()` deleted, `creating a project selects
 * the whole placeholder name` failed on `expected [ 11, 11 ] to deeply equal
 * [ +0, 11 ]` — the caret at the end of `New project` rather than a selection
 * over it. With the effect's dependency list removed, so it ran on every
 * render as an inline ref would, `does not put the whole draft back under the
 * next keystroke` failed on `expected [ +0, 1 ] to deeply equal [ 1, 1 ]` —
 * the one typed character selected again, and gone on the next. Watched
 * 2026-08-29.
 */
function ProjectNameField({
  draft,
  selectsWholeDraft,
  onDraft,
  onCommit,
  onCancel,
}: {
  draft: string;
  /** Whether the whole draft is selected on arming, so one keystroke replaces it. */
  selectsWholeDraft: boolean;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactNode {
  const field = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    const node = field.current;
    // Narrowing, not a guard: a layout effect runs on a mounted node, so no
    // injected fault can make this null and a throw here would be a check
    // whose failure can never be observed. That the focus happens at all is
    // asserted instead, by `creating a project puts the caret in its name`.
    if (node === null) return;
    node.focus();
    if (selectsWholeDraft) node.select();
    // Once per arming: `key` on the caller remounts this for another project.
  }, [selectsWholeDraft]);
  return (
    <Input
      ref={field}
      className="h-8 max-w-72 min-w-0 flex-1"
      aria-label="Project name"
      value={draft}
      onChange={(e) => {
        onDraft(e.target.value);
      }}
      // Blur commits — the proposal's word — which also gives the rename a
      // mouse exit: click anywhere else and the mode resolves instead of
      // sitting open forever.
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        }
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

/**
 * Picks a project, remembers the pick, renames it, then hands it to the table.
 *
 * It renders the page's two structural pieces: the {@link AppHeader} the picker
 * lives in, and the `<main>` the table fills. The header is here rather than in
 * `App` because the picker is the bar's widest control and its state — the
 * list, the selection, the rename in progress — is this page's; `App` passes in
 * the two slots that belong to the session instead.
 *
 * `<main>` is a column flex that takes the rest of the window, and from it down
 * to `TABLE_FRAME` there is one unbroken `flex-1` / `min-h-0` chain. Break a
 * link of it and the frame stops being the thing that scrolls — the page starts
 * scrolling instead and the heading row scrolls away with it, which is the
 * failure `table-frame.ts` describes.
 */

/**
 * The saved-plan shelf: a disclosure in the app header's project row, beside
 * the picker, Rename and New project.
 *
 * **Its own component, and the reason is a bug this had.** The disclosure needs
 * `useClosedByPointerOutside`, whose effect reads `ref.current` once with an
 * empty dependency list — so the hook has to mount in the same commit as the
 * `<details>` it is given. Held on {@link ProjectPage} instead (which renders
 * first with no project selected and therefore no shelf), `panel.current` is
 * `null` when the effect runs, the effect returns early, the `pointerdown`
 * listener is **never** registered, and the panel can only be closed from its
 * own chip. Caught by the Gemini seat on PR 202 as F-01. Every other caller of
 * that hook (`wbs-table.tsx`'s Views, Columns, Facets and Export) is a component
 * that renders its own `<details>` unconditionally, which is what this now is.
 *
 * **And its own component is also why the second fault was cheap to repair.**
 * It shipped `absolute right-4 bottom-2 z-40` against `<main>`, which sat it on
 * top of the chart's `[data-gantt-fullscreen-toggle]` and
 * `[data-gantt-svg-download]` — the last two children of a control strip that
 * packs from the left, so no other corner is better — and put `z-40` above the
 * full-screen chart's `aria-modal` layer. Gemini F-03 and Sol I4, found
 * independently. The repair is to stop floating, and `z-50` on the panel is
 * what the chart's modal now outranks.
 *
 * **Costing the plan column nothing is not a preference, and this is the
 * fourth shape to try for it.** The first three each failed to a browser
 * measurement that already existed, and the list is the argument for where it
 * ended up:
 *
 * 1. *A flex sibling of the table* (`mt-2 max-h-64 shrink-0`): `shrink-0` did
 *    exactly what it says — ~76px off the one column whose whole invariant is
 *    reaching the bottom of the window. Four measurements said so at once —
 *    `header.spec.ts:272` wanted the frame >= 634 and got 601, `:289` and
 *    `plan-surface.spec.ts:278` both wanted <= 16px under the surface and got
 *    76, and `plan-surface.spec.ts:318` said the same for a plan that fills the
 *    frame. Raising those thresholds is the wrong repair:
 *    `plan-surface.spec.ts:300` exists to say that what reaches the bottom must
 *    be the chart itself, "not a control strip that parted company with it".
 *    Above the table is no better — `:272` measures the frame's own
 *    `clientHeight`, so height lost anywhere in the column fails it the same —
 *    and inside the scrolling frame is ruled out by `plan-surface.spec.ts:288`,
 *    which requires `frame.scrollHeight === frame.clientHeight` on a short plan.
 * 2. *A floating chip over `<main>`*: the two findings above.
 * 3. *A plain control in the plan toolbar*, handed to the table's own row.
 *    "It costs the column no height because that row already exists" is true
 *    only **while the row does not gain a line**, and it does: the row has a
 *    measured width budget with a named margin for exactly one more control,
 *    and "Saved plans" spent it. Run
 *    [33871922414](https://github.com/Prosperous-Unification/wbs-tool-v1/actions/runs/33871922414)
 *    at `14a1a070`, 2 failed / 281 passed —
 *    `project-settings.spec.ts:77` ("the toolbar keeps its 1280 budget with one
 *    settings control") measures `[data-toolbar]`'s children against 1265px and
 *    a fifth disclosure puts it over, and `gantt.spec.ts:2605`
 *    ("re-measures the room when the toolbar wraps under a new control") needs
 *    the bar to be **one** row at 768 before the drag that adds `Reset layout`
 *    makes it two — with this control on it the bar is already two, so the
 *    wrap the case is about cannot be observed.
 * 4. *The app header's project row*, which is where it is. The header is
 *    `shrink-0` with `md:flex-nowrap` and a `max-w` picker that takes the
 *    slack, so a control added here changes no height at any laptop width — it
 *    narrows the picker instead of wrapping (`header.spec.ts`, "keeps the
 *    header to one row at every laptop width"). It costs `[data-toolbar]`
 *    nothing because it is not in it, and it costs the plan column nothing
 *    because it is not in that either: the header is outside `<main>`.
 *
 * **And the header is where it belongs rather than merely where it fits.**
 * These are the plans saved for *this project*, and the row it now sits in is
 * the project's own — pick a project, rename it, start a new one, read its
 * history.
 *
 * **On a phone it is not in that row, and the reason is 21.4 measured pixels.**
 * The header's project group takes a line of its own below `md`, and with the
 * shelf on it that line costs 36px: the phone header is 137px in three rows and
 * `[data-plan-cards]` starts at 195. `mobile.spec.ts:850` needs the card
 * scroller's top at 173.6 or less — the sheet is capped at `85vh`, so its top
 * is 126.6, and a card's `Plan actions` trigger sits 55px below the scroller's
 * own top edge, which is where the last card lands at the scroll ceiling. So
 * the guard's goal was *unreachable*, not unreached, and no padding closes it:
 * `[data-plan-cards]` is `flex-1 min-h-0` and padding is not shrinkable, so
 * past its 641px the content box clamps to 0 and `scrollHeight - clientHeight`
 * does not move (13372 both times, measured on h2puni 2026-09-04).
 *
 * Taking the shelf off that row drops the header to 101 and the scroller to
 * 159 — clearing the criterion by 14.6px — and puts the remaining three
 * controls back on row 1 at 132.125px, so run 16's 25px of horizontal overflow
 * does not come back with them. Both numbers are a browser's, from a throwaway
 * probe run before this shape was written rather than a CI cycle after it.
 *
 * So the shelf is drawn by whichever surface the viewport is already using: the
 * header's project row on a table viewport, and the phone's `Plan actions`
 * sheet on a cards one. {@link useRendererForViewport} decides, so exactly one
 * of the two is mounted at any width and neither is a hidden duplicate. Below
 * `md` it cannot simply be *absent* — AC #2 is "saved plans are available
 * chronologically", and a phone is the surface this task exists for.
 */
function SavedPlanShelf({
  projectId,
  deps,
  placement,
}: {
  projectId: string;
  /**
   * Required, and it is CI that says so. `SavedPlansPanel.deps` is not
   * optional, so an optional prop here forwarded `SavedPlansPanelDeps |
   * undefined` into it — `fe-01:typecheck` TS2322 at
   * `project-page.tsx(298,50)`, red on the run at `adb58ad9` and invisible on
   * h2puni, which OOM-killed that target three times running. The one caller
   * has always passed the memoised `savedPlans`, which is never `undefined`.
   */
  deps: SavedPlansPanelDeps;
  /**
   * Which surface is drawing it, which is the whole of what differs between
   * the two: the panel *floats* over the page from the header, and *flows*
   * inside the sheet.
   *
   * A phone cannot have the floating one. It is `absolute right-0 w-96` — 384px
   * anchored to the chip's right edge — so on a 390px screen it paints off the
   * left of the viewport, which is the horizontal overflow four e2e cases
   * already fail on. Inside the sheet there is nothing to float over anyway:
   * the sheet is a bottom sheet that already owns the width, so the panel is
   * an ordinary block in it and the sheet grows by exactly what is open.
   */
  placement: 'header' | 'sheet';
}): ReactNode {
  const inSheet = placement === 'sheet';
  return (
    /*
      `shrink-0` for the reason the brand and the two fold-in buttons beside it
      carry one: above `md` the header is `flex-nowrap`, and what absorbs a new
      control is the picker's `max-w` slack. Shrinkable, this chip would give up
      its own width first and the label would clip before the picker gave an
      inch. In the sheet the chip is instead the full width of the sheet, which
      is what the controls beside it are.
    */
    <details
      ref={useClosedByPointerOutside()}
      data-saved-plans
      className={inSheet ? 'w-full' : 'relative shrink-0'}
    >
      <summary
        className={
          inSheet
            ? 'border-input flex min-h-11 cursor-pointer items-center rounded-md border px-3 text-sm select-none'
            : 'border-input h-8 cursor-pointer rounded-md border px-2 py-1 text-xs select-none'
        }
        data-hint="The plans saved for this project, and what changed since one of them"
      >
        Saved plans
      </summary>
      <div
        data-saved-plans-panel
        className={
          inSheet
            ? 'mt-1 max-h-80 w-full overflow-y-auto rounded-md border p-3 text-sm'
            : 'bg-popover absolute right-0 z-50 mt-1 max-h-80 w-96 overflow-y-auto rounded-md border p-3 text-sm shadow-md'
        }
      >
        <SavedPlansPanel projectId={projectId} deps={deps} />
      </div>
    </details>
  );
}

export function ProjectPage({
  token,
  api: apiOverride,
  savedPlansDeps: savedPlansOverride,
  presence,
  account,
  nav,
}: ProjectPageProps) {
  const api = useMemo(() => apiOverride ?? httpProjectApi(token), [apiOverride, token]);
  /**
   * The shelf's wiring, memoised — and the memo is load-bearing rather than
   * tidy.
   *
   * `browserSavedPlansDeps` builds a fresh object every call, and the panel
   * puts that object in two dependency arrays (`useSavedPlanShelf`'s watch and
   * the compare effect). Unmemoised it would be a new identity on every render
   * of this page — every keystroke in the picker — so the shelf would resubscribe
   * and the comparison would refetch while somebody was typing a project name.
   */
  const savedPlans = useMemo(
    () => savedPlansOverride ?? browserSavedPlansDeps(token),
    [savedPlansOverride, token],
  );
  /**
   * Who else is in the selected project, and whether the socket saying so is
   * up.
   *
   * Held here because this page renders both halves of the screen the answer
   * is for: the header's panel and the `<main>` the table fills. The table
   * opens the stream (it is the thing that has to refetch), so the roster
   * arrives through the factory below rather than from a socket of the header's
   * own.
   */
  const [roster, setRoster] = useState<Roster>({
    users: [],
    connected: false,
  });
  const subscribe = useMemo(
    () => (projectId: string, handlers: SubscriptionHandlers) =>
      subscribeToProject({
        projectId,
        // The table's first read has not happened yet, so the stream starts
        // knowing nothing and the read reports its sequence through `seen`.
        sinceSeq: -1,
        onChange: handlers.onChange,
        onConnectionChange: (connected) => {
          setRoster((current) => ({ ...current, connected }));
          handlers.onConnectionChange(connected);
        },
        onPresence: (users) => {
          setRoster((current) => ({ ...current, users }));
        },
      }),
    [],
  );

  /**
   * The picker's own box, for the one thing state cannot say: give up the
   * keyboard. See {@link ProjectPage}'s `choose`.
   */
  const pickerBox = useRef<HTMLInputElement | null>(null);
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The rename in progress, or null while the picker is showing.
   *
   * It carries the id of the project it was opened for, and the commit uses
   * that id — never the current selection. Cross review #6's one critical
   * finding, from all three reviewers: with only the draft stored, arming a
   * rename and then creating a project sent the old draft to the new project.
   */
  const [rename, setRename] = useState<{
    projectId: string;
    draft: string;
    /**
     * Whether the draft is the placeholder name a create put there, which the
     * field selects whole so the first keystroke replaces it.
     *
     * False for the ✎, which arms a rename on a name somebody chose: selecting
     * that would put a whole considered name one keystroke from gone.
     */
    draftIsPlaceholder: boolean;
  } | null>(null);
  /**
   * What has been typed into the picker, and which entry is highlighted — or
   * null while the picker is closed.
   *
   * `null` rather than a separate `open` flag: "closed" and "nothing typed"
   * are two different states (a closed picker shows the project's name, an
   * open empty one shows every project), and two booleans that must agree is
   * one more thing to keep in step. The highlight is an entry's id, never an
   * index — the same reason the Depends on picker holds one (cross review #6).
   */
  const [search, setSearch] = useState<{ typed: string; highlightId: string | null } | null>(null);
  /**
   * Which entry the pointer is resting on, or null.
   *
   * Separate from the keyboard's `highlightId` because they are two different
   * facts about the same list: the pointer can rest on one entry while the
   * keyboard (or the initial highlight) points at another. The card and its
   * anchor are resolved from whichever of the two is active,
   * pointer-first.
   */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /**
   * Owns the hover at the list's lifecycle boundary.
   *
   * `hoveredId` is set on an option's `mouseenter` and cleared only on its
   * `mouseleave`. Every close path — Escape, blur, and `choose` — unmounts the
   * options without firing that `mouseleave`, so the pointer id it last held
   * outlives the list it pointed into. A reopened list would then show the
   * last-hovered project's card even while the keyboard highlights another (or
   * nothing). Cleared here, whenever the picker closes, so a closed list owns
   * no hover.
   */
  useEffect(() => {
    if (search === null) setHoveredId(null);
  }, [search]);

  const load = useCallback(async () => {
    const found = await api.listProjects();
    setProjects(found);
    setSelected((current) => {
      // The current selection and the remembered id are both claims, honoured
      // only while the list still contains them — a project deleted elsewhere
      // must not stay "selected" into a table asking for its tree. Then,
      // selecting the only project saves a click on the common path; with
      // several, the choice is the user's and nothing is guessed.
      if (current !== null && found.some((project) => project.id === current)) return current;
      const remembered = localStorage.getItem(PROJECT_KEY);
      if (remembered !== null && found.some((project) => project.id === remembered)) {
        return remembered;
      }
      // A remembered id the list no longer holds is a claim that has been
      // disproved, so it is dropped rather than left to be re-tested — and
      // re-offered as a choice — on every future load.
      if (remembered !== null) rememberProject(null);
      return found.length === 1 ? (found[0]?.id ?? null) : null;
    });
  }, [api]);

  useEffect(() => {
    void load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'load_failed');
    });
  }, [load]);

  /**
   * Tells be-01 which project this account is now in, which is what sorts the
   * picker next time.
   *
   * On the selection rather than on the click, so every way of arriving at a
   * project counts: picked from the list, restored from localStorage,
   * auto-selected as the only one, or just created. Recording it in the click
   * handler would have left the restored project — the commonest arrival of
   * all — never marked as opened, and the ordering would drift by exactly the
   * projects people return to most.
   *
   * A failure is swallowed on purpose: this is navigation history, and an
   * error banner over a list that will simply be ordered slightly stale is
   * noise about something the user cannot act on.
   */
  useEffect(() => {
    if (selected === null) return;
    void api.openProject(selected).catch(() => {
      // Deliberate: see above.
    });
  }, [api, selected]);

  /**
   * Creates a project, selects it, and puts the caret in its name.
   *
   * The re-arm is **after** `await load()`: the name field renders in place of
   * the picker, and arming it before the list holds the new project puts a
   * commit target on screen for a project this page cannot yet name — an
   * immediate Enter would then compare the draft against no current name at
   * all and send a rename for the name the row already has.
   *
   * Proof: the re-arm moved above `await load()` — `arms the rename only once
   * the list can name the new project` failed on `expected <input …(3)></input>
   * to be null`, the field on screen while the reload was still in flight.
   * Watched 2026-08-29.
   *
   * The draft is the placeholder rather than an empty box, and it is selected
   * rather than cleared: `commitOrCancelRename` reads an empty draft as a
   * cancel, so a reader who saw an empty field and pressed Enter would get a
   * project called `New project` and no explanation.
   */
  const create = () => {
    // An armed rename is cancelled, not carried: the draft was meant for the
    // project it was opened on, and this click is about to select another.
    //
    // Proof: this line deleted — `a draft armed for another project does not
    // follow the create` failed on `expected 'Meant for p2' to be null`, the
    // old project's typing still on screen and still aimed at it while the
    // create was in flight. Watched 2026-08-29.
    setRename(null);
    void api
      .createProject(PLACEHOLDER_PROJECT_NAME)
      .then(async (project) => {
        setSelected(project.id);
        rememberProject(project.id);
        await load();
        setRename({
          projectId: project.id,
          draft: PLACEHOLDER_PROJECT_NAME,
          draftIsPlaceholder: true,
        });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'create_failed');
      });
  };

  /**
   * Commits the rename if it says something, cancels if it does not.
   *
   * A draft that trims to nothing or to the name the project already has is a
   * cancel — a blank name would leave the project unidentifiable in every
   * picker, and an unchanged one is a request that changes nothing. A refusal
   * keeps the draft on screen: `forbidden` must not eat what was typed. The
   * post-success list reload fails separately — by then the rename landed,
   * and reporting it as a rename failure would be a lie.
   */
  const commitOrCancelRename = (armed: { projectId: string; draft: string }) => {
    const typed = armed.draft.trim();
    const currentName = projects.find((project) => project.id === armed.projectId)?.name;
    if (typed === '' || typed === currentName) {
      setRename(null);
      return;
    }
    setError(null);
    void api.renameProject(armed.projectId, typed).then(
      async () => {
        setRename(null);
        await load().catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'load_failed');
        });
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : 'rename_failed');
      },
    );
  };

  const selectedProject = projects.find((project) => project.id === selected);

  /** The entries the picker is offering right now, or none while it is closed. */
  const entries = search === null ? [] : matchingProjects(projects, search.typed);
  /**
   * The reader's own today, which is the year an entry meta's is measured
   * against — one per render rather than one per entry, so a list opened across
   * midnight on New Year's Eve at least prints one year throughout.
   */
  const now = new Date();
  // Resolved by id at render, so a highlight whose project has left the list is
  // simply nothing rather than somebody else's project.
  const highlighted =
    search?.highlightId == null
      ? undefined
      : entries.find((entry) => entry.id === search.highlightId);
  const listOpen = search !== null && entries.length > 0;
  /**
   * The entry whose hover card is open, and the rectangle it is placed
   * against.
   *
   * The pointer wins over the keyboard highlight: resting on an entry shows
   * that entry even while the arrows hold another. The card id is an entry's
   * id, resolved against `entries` so an entry scrolled out of the narrowed
   * list simply has no card rather than somebody else's. The anchor is read
   * from the option element by its `id` in a layout effect below, because the
   * mouseenter handler that first sets `hoveredId` fires before React has
   * re-rendered, and the element that will carry the `id` is the one thing
   * that can be asked where the card is meant to open.
   */
  const cardId = listOpen ? (hoveredId ?? highlighted?.id ?? null) : null;
  const cardEntry = cardId === null ? undefined : entries.find((entry) => entry.id === cardId);

  /**
   * Takes a project: selects it, remembers it, closes the picker, and gives
   * the keyboard back.
   *
   * The blur is the third of those and not tidiness. Nothing focuses the
   * option — the list's `mousedown` is prevented so the click can land — so
   * without it the combobox keeps the focus, and a closed combobox shows the
   * chosen project's **name**: a text field holding the project's name with a
   * caret in it, indistinguishable from an armed rename that does not exist.
   *
   * Proof: the `blur()` removed — `choosing a project takes the focus off the
   * picker` failed on `expected <input …(9)></input> not to be <input
   * …(9)></input>`, the combobox still holding the keyboard after the pick.
   * Watched 2026-08-29.
   */
  const choose = (id: string) => {
    setSelected(id);
    rememberProject(id);
    setSearch(null);
    pickerBox.current?.blur();
  };

  /** Moves the picker highlight by `delta` over what is on offer, clamped. */
  const moveHighlight = (delta: 1 | -1) => {
    if (entries.length === 0) return;
    setSearch((current) => {
      if (current === null) return current;
      const ids = entries.map((entry) => entry.id);
      const at = current.highlightId === null ? -1 : ids.indexOf(current.highlightId);
      // From nothing highlighted — or a highlight whose project left the list —
      // Down enters at the top and Up at the bottom.
      const from = at === -1 ? (delta === 1 ? -1 : ids.length) : at;
      const to = Math.min(ids.length - 1, Math.max(0, from + delta));
      return { ...current, highlightId: ids[to] ?? null };
    });
  };

  /**
   * Which of the two plan surfaces this viewport is drawing, asked here for the
   * one thing this page decides with it: where {@link SavedPlanShelf} is
   * mounted.
   *
   * The same hook {@link WbsTable} uses, and deliberately not a prop threaded
   * down from it: it is `useSyncExternalStore` over one `resize` subscription
   * and a pure function of `window.innerWidth`/`innerHeight`, so two callers
   * cannot disagree within a render, and the second subscription costs a
   * listener rather than a source of truth.
   *
   * A CSS `hidden md:block` pair would be cheaper and is wrong here: it leaves
   * both shelves mounted, so `[data-saved-plans]` matches twice, two
   * `useSavedPlanShelf` watches subscribe, and every e2e selector on that
   * attribute becomes a strict-mode violation the moment the phone's sheet is
   * open.
   */
  const renderer = useRendererForViewport();
  /**
   * The project's history, mounted by whichever surface is drawing the plan.
   *
   * Absent off a project for the reason {@link AppHeader}'s `project` slot
   * gives for the whole row: a control that belongs to a project is absent off
   * the project rather than drawn dead — and `projectId` is a `string` in
   * {@link SavedPlanShelf}, so absence is the type as well as the taste.
   *
   * The key remounts it per project. The panel pins its compare pair once, on
   * the first shelf that arrives (AC #4: a comparison must not be swapped under
   * the reader), and that pin is `useState` — kept across a project switch it
   * would hold a saved-plan id belonging to the project just left, and the
   * first compare of the new project would ask be-01 about a checkpoint that is
   * not in it. Crossing the renderer breakpoint remounts it for the same
   * reason, and that is a resize somebody performed, not an update arriving
   * under them.
   *
   * **Prefixed, and the bare `key={selected}` this carried in the toolbar is a
   * bug in the header row.** `ProjectNameField` two slots up is keyed
   * `rename.projectId`, and those are static JSX children — one array, one key
   * map. While a rename is armed on the open project both keys are that
   * project's id, React reports "Encountered two children with the same key,
   * `p2`", and the omission it warns about is real: cancelling the rename left
   * the field mounted with its draft intact. Four cases in
   * `project-page.test.tsx` went red on it at `c1b51324` (`cancels on Escape`,
   * `a blur that changed nothing cancels`, `an emptied draft cancels`, `a draft
   * armed for another project does not follow the create`) — all four are
   * cancels, because a cancel is the update whose whole job is to unmount that
   * child.
   */
  const savedPlanShelf =
    selected === null ? null : (
      <SavedPlanShelf
        key={`saved-plans-${selected}`}
        projectId={selected}
        deps={savedPlans}
        placement={renderer === 'cards' ? 'sheet' : 'header'}
      />
    );
  /**
   * The project controls, as one group of the header bar.
   *
   * `min-w-0` on the box and on the group is what lets the picker be the part
   * that gives way: without it a flex item refuses to shrink below its content
   * and the bar wraps at the width the longest project name asks for.
   *
   * **`flex-1`, and the phone's sideways scroll is closed by the shelf leaving
   * this row rather than by the row taking a line of its own.** The five red
   * pixel cases at `22464b72` were one defect measured five times — the page
   * 415px wide in a 390px viewport, 25px over, in `gantt.spec.ts:1449`,
   * `header.spec.ts:345`, `mobile.spec.ts:255`, `:404` and `:965`, every one an
   * overflow assertion and none of them the 44px touch-target assertion that
   * sits two lines above one of them and passed.
   *
   * The mechanism was `flex-1`'s `flex-basis: 0%`. {@link AppHeader} wraps below
   * `md`, but a zero-basis item never *asks* for a line: it is handed whatever
   * is left over — about 135px beside the brand and the account group — and
   * `min-w-0` lets it be squeezed to that. Its own children then decide the
   * width, and three of the *four* were `shrink-0` (`✎`, `+`,
   * {@link SavedPlanShelf}, ~160px with the gaps). What does not fit does not
   * wrap; it paints past the viewport.
   *
   * `basis-full md:basis-0` fixed that by making the group ask for its own
   * line, and the line cost 36px of header — which `mobile.spec.ts:850` cannot
   * afford, for the arithmetic {@link SavedPlanShelf} carries. So the fix is
   * the other half of the same sentence: **the shelf did not create the squeeze,
   * it exceeded it** — at ~76px of `shrink-0` children the group still fit. Off
   * a cards viewport the group is three children with 64px unshrinkable against
   * ~156px free on row 1 at 390, and a browser measured the whole group at
   * 132.125px there with `scrollWidth === clientWidth` on the header and no
   * page overflow at all.
   *
   * Above `md` nothing about this changed at any point: the header is
   * `flex-nowrap`, `flex-1` is what it always was, and the picker's `max-w`
   * slack absorbs the shelf at every laptop width (`header.spec.ts`, "keeps the
   * header to one row at every laptop width").
   */
  const projectControls = (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {rename === null ? (
        <>
          <span className="relative inline-block max-w-72 min-w-0 flex-1">
            <Input
              ref={pickerBox}
              className="h-8 w-full"
              aria-label="Project"
              role="combobox"
              // At rest the box is the label of what is open, and a label is
              // not typed into: `readOnly` is what stops a click on the closed
              // picker putting a caret in the project's name. It is dropped
              // the moment the box takes the focus — the same commit that
              // opens the list — so every route in still types.
              //
              // `readOnly` and not `disabled`: a disabled combobox is out of
              // the tab order and cannot be opened from the keyboard at all.
              //
              // jsdom cannot be the oracle for this half. A click's default
              // action — the focus and the caret it places — is the browser's,
              // and jsdom performs none of it (R5 #14/#15). The negative lives
              // in `e2e/project-picker.spec.ts`.
              readOnly={search === null}
              aria-expanded={listOpen}
              aria-controls={listOpen ? 'project-options' : undefined}
              aria-activedescendant={
                highlighted === undefined ? undefined : `project-option-${highlighted.id}`
              }
              aria-autocomplete="list"
              placeholder="Choose a project…"
              size={28}
              // Closed, the box reads as a label of what is open; typing in
              // it is a search, and the typing is what is shown then.
              value={search?.typed ?? selectedProject?.name ?? ''}
              onFocus={() => {
                setSearch({ typed: '', highlightId: null });
              }}
              // A blur discards the typing and shows the selection again. It
              // does not select the highlighted entry: a click elsewhere is
              // not a choice, and choosing on the way out is how a picker
              // silently changes the project under someone who left it.
              onBlur={() => {
                setSearch(null);
              }}
              onChange={(e) => {
                const typed = e.target.value;
                // Typing is aiming at the narrowed-to project; emptying the
                // box aims at nothing again.
                const first =
                  typed.trim() === '' ? undefined : matchingProjects(projects, typed)[0];
                setSearch({ typed, highlightId: first?.id ?? null });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
                  return;
                }
                if (e.key === 'Escape') {
                  setSearch(null);
                  return;
                }
                if (e.key !== 'Enter') return;
                e.preventDefault();
                // Nothing highlighted is not a choice. An empty box whose
                // list happens to be showing must not select the first
                // project on a stray Enter.
                if (highlighted !== undefined) choose(highlighted.id);
              }}
            />
            {listOpen && (
              <ul
                role="listbox"
                id="project-options"
                aria-label="Projects"
                // One preventDefault for the whole list, options included, by
                // bubbling: a mousedown here must not blur the input, or the
                // list would close before the click could land — on an option
                // and on the scrollbar alike (cross review #6's lesson,
                // learned on the Depends on picker).
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                // `w-full`, not `min-w-full`. An absolutely positioned box with
                // only a minimum is shrink-to-fit, so one long entry decides
                // how wide the list is — and with `whitespace-nowrap` below,
                // that is as wide as the entry wants, past the right edge of
                // the window and giving the whole document a horizontal
                // scrollbar. The width is the combobox's instead: the input is
                // inside the bar, the bar is inside the viewport, so the list
                // is too, whatever be-01 answers with. Entries clip.
                //
                // Proof: back to `min-w-full`, `the widest entry be-01 permits
                // stays inside the window` in `e2e/header.spec.ts` failed at
                // every one of 1280, 1024 and 900 on the precondition —
                // `entryOverflow 0`, nothing clipped anywhere, the list simply
                // as wide as the text — and, with that precondition relaxed to
                // read the bound underneath, on `the listbox reaches 46px past
                // the window at 900px`. Watched in Chromium, 2026-08-09.
                className="bg-popover text-popover-foreground absolute top-full left-0 z-10 m-0 max-h-60 w-full max-w-[calc(100vw-1rem)] list-none overflow-y-auto rounded-md border p-1 text-sm shadow-md"
              >
                {entries.map((entry) => (
                  // The ARIA combobox pattern is the boundary that makes this
                  // safe: options are not focusable, and the keyboard drives
                  // them from the input through aria-activedescendant.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={entry.id}
                    id={`project-option-${entry.id}`}
                    role="option"
                    // The native `title` is gone: its delay is exactly the
                    // "immediately" this change rejects, and the hover card
                    // below shows the same full name and meta with none. The
                    // option's accessible name already carries the whole text,
                    // so nothing a screen reader overhears is lost.
                    onMouseEnter={() => {
                      setHoveredId(entry.id);
                    }}
                    onMouseLeave={() => {
                      setHoveredId((current) => (current === entry.id ? null : current));
                    }}
                    aria-selected={entry.id === highlighted?.id}
                    ref={(element) => {
                      // jsdom has no scrollIntoView; that boundary is the
                      // test environment, not a browser this will meet.
                      if (
                        entry.id === highlighted?.id &&
                        element !== null &&
                        typeof element.scrollIntoView === 'function'
                      ) {
                        element.scrollIntoView({ block: 'nearest' });
                      }
                    }}
                    className={cn(
                      'flex cursor-pointer items-baseline gap-1 rounded-sm px-2 py-1 whitespace-nowrap',
                      entry.id === highlighted?.id && 'bg-accent text-accent-foreground',
                    )}
                    onClick={() => {
                      choose(entry.id);
                    }}
                  >
                    {/*
                      The name is shown whole and the meta is the half that
                      gives way — `shrink-0` here, `min-w-0 truncate` on the
                      meta below. The other way round, a long owner name (an
                      e2e run's generated account, say) squeezed every `New
                      project …` to `New pr…` and the picker offered choices
                      nobody could tell apart — Dany, 2026-08-10. A name wider
                      than the listbox itself still clips at the box's edge
                      (the viewport is the physical bound, and the hover card
                      carries the full text); the meta never causes it.
                      `whitespace-nowrap` above stays — the entry is one line
                      whether it fits or not, and wrapping instead would make a
                      long name a two-row option rather than a clipped one.
                    */}
                    <span className="shrink-0">{entry.name}</span>
                    {/*
                      A real space in the text, not only the `gap` beside it: an
                      entry's accessible name is `Rewire the shed (kat · 1 Jun)`
                      and the string somebody hears has to have the word break
                      in it. A whitespace-only node between two flex items is
                      not itself an item, so it costs no second gap on screen.
                    */}{' '}
                    {/*
                      Inside the option, so it is part of the accessible name:
                      two projects called `Rewire the shed` are told apart by a
                      screen reader as well as by eye. A `title` or a sibling
                      element outside the option would look identical and say
                      nothing to anybody listening.

                      Proof: with `aria-hidden="true"` on this span — the meta
                      still on screen, out of the accessibility tree — `tells
                      two projects of one name apart by their owners` failed on
                      `Unable to find an accessible element with the role
                      "option" and name "Rewire the shed (kat · 1 Jun)"`.
                      Watched, 2026-08-09.
                    */}
                    <span className="text-muted-foreground min-w-0 truncate">
                      {entryMeta(entry, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/*
              The card owns its scroll listener and anchor state: a wheel tick
              repositions this small child, not the WBS table below the header.
              Off-list options answer no anchor, so a keyboard highlight cannot
              leave a portal floating outside the listbox. Proof: the two scroll
              regressions in `project-page.test.tsx` failed on a parent rerender
              and a still-mounted off-list card. Watched 2026-08-24.
            */}
            <ProjectOptionCard entry={cardEntry} now={now} />
          </span>
          {selectedProject !== undefined && (
            <Button
              variant="outline"
              size="square"
              type="button"
              // The name every test knows this control by, kept exactly while
              // the label it used to carry left the bar: an icon button in a
              // one-row header is a smaller thing with the same accessible
              // name, and `aria-label` is what makes those two facts one.
              aria-label="Rename"
              data-hint="Rename this project"
              onClick={() => {
                setRename({
                  projectId: selectedProject.id,
                  draft: selectedProject.name,
                  draftIsPlaceholder: false,
                });
              }}
            >
              ✎
            </Button>
          )}
        </>
      ) : (
        <ProjectNameField
          // The armed project, so arming a rename on another one is a new
          // field rather than the same one holding somebody else's name: the
          // focus and the selection below happen on mount.
          key={rename.projectId}
          draft={rename.draft}
          selectsWholeDraft={rename.draftIsPlaceholder}
          onDraft={(draft) => {
            setRename((current) => (current === null ? current : { ...current, draft }));
          }}
          onCommit={() => {
            commitOrCancelRename(rename);
          }}
          onCancel={() => {
            setRename(null);
          }}
        />
      )}
      <Button
        size="square"
        type="button"
        aria-label="New project"
        data-hint="Start a new project"
        onClick={create}
      >
        +
      </Button>
      {/*
        The project's history, on a table viewport only — on a cards one it is
        in the phone's `Plan actions` sheet instead, and `savedPlanShelf` has
        why that is 21.4 measured pixels rather than a preference.
      */}
      {renderer === 'table' && savedPlanShelf}
    </div>
  );

  return (
    <>
      <AppHeader
        nav={nav}
        project={projectControls}
        presence={presence?.(roster)}
        account={account}
      />
      {/*
        The rest of the window, and a column flex so the frame below can have
        what the toolbar does not. `min-h-0` is the load-bearing half: a flex
        item's default `min-height: auto` refuses to shrink below its content,
        so without it the table's own height would push this box past the
        bottom of the screen and the frame would never be the thing that
        scrolls.

        `relative` stays: the shelf's panel is absolutely positioned, and
        several of the table's own menus are too, so this column is the
        containing block they are all measured against.
      */}
      <main className="relative flex min-h-0 flex-1 flex-col px-4 py-2">
        {error !== null && (
          <p role="alert" className="text-destructive mb-2 text-sm">
            {error}
          </p>
        )}
        {selected !== null && (
          <WbsTable
            projectId={selected}
            // The name the export's header and filename carry. Read from the
            // list rather than held twice: a rename lands in `projects` and the
            // next export says the new name.
            projectName={selectedProject?.name}
            api={api}
            subscribe={subscribe}
            // Rendered by the table only on a cards viewport, which is the
            // same answer `renderer` above gives — one hook, one store, so the
            // header's arm and this one are complementary and never both.
            savedPlansShelf={savedPlanShelf}
          />
        )}
      </main>
    </>
  );
}
