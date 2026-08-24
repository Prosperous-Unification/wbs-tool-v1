import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { AppHeader } from '@/components/chrome/app-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { subscribeToProject } from '@/lib/project-stream';
import { cn } from '@/lib/utils';
import { httpProjectApi, type ProjectApi, type ProjectListEntry } from '@/lib/wbs-api';

import { type AnchorRect, HoverCard } from './hover-card';
import { entryMeta, matchingProjects, projectCardMeta } from './project-picker';
import { type SubscriptionHandlers, WbsTable } from './wbs-table';

export interface ProjectPageProps {
  token: string;
  /** Injected in tests; the app lets it default to the real one. */
  api?: ProjectApi;
  /**
   * Who else is in the project, for the right-hand end of the header bar.
   *
   * A function of the selected project rather than the panel itself, because
   * what the panel needs — the session's own username — is the app's and not
   * this page's, and because a page that built its own presence panel would
   * open a gateway socket in every test that renders one.
   *
   * It takes the selection because a roster is a project's: gw-01 scopes it by
   * the project a socket subscribed to (F4), and the selection lives here. It
   * is called with null while no project is open, which is a real state — a
   * fresh account with nothing selected has no roster to be in.
   */
  presence?: (projectId: string | null) => ReactNode;
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

function rememberProject(id: string | null): void {
  if (id === null) localStorage.removeItem(PROJECT_KEY);
  else localStorage.setItem(PROJECT_KEY, id);
}

/** The current viewport rectangle of an option while it remains visible in its listbox. */
function projectOptionAnchor(id: string | null, listbox: HTMLElement | null): AnchorRect | null {
  if (id === null || listbox === null) return null;
  const option = document.getElementById(`project-option-${id}`);
  if (option === null) return null;
  const box = option.getBoundingClientRect();
  const list = listbox.getBoundingClientRect();
  if (box.bottom <= list.top || box.top >= list.bottom) return null;
  return { left: box.left, top: box.top, bottom: box.bottom };
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
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
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
    <HoverCard anchor={anchor} label={entry.name}>
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
export function ProjectPage({ token, api: apiOverride, presence, account, nav }: ProjectPageProps) {
  const api = useMemo(() => apiOverride ?? httpProjectApi(token), [apiOverride, token]);
  const subscribe = useMemo(
    () => (projectId: string, handlers: SubscriptionHandlers) =>
      subscribeToProject({
        token,
        projectId,
        // The table's first read has not happened yet, so the stream starts
        // knowing nothing and the read reports its sequence through `seen`.
        sinceSeq: -1,
        onChange: handlers.onChange,
        onConnectionChange: handlers.onConnectionChange,
      }),
    [token],
  );

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
  const [rename, setRename] = useState<{ projectId: string; draft: string } | null>(null);
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

  const create = () => {
    // An armed rename is cancelled, not carried: the draft was meant for the
    // project it was opened on, and this click is about to select another.
    setRename(null);
    void api
      .createProject('New project')
      .then(async (project) => {
        setSelected(project.id);
        rememberProject(project.id);
        await load();
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

  /** Takes a project: selects it, remembers it, and closes the picker. */
  const choose = (id: string) => {
    setSelected(id);
    rememberProject(id);
    setSearch(null);
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
   * The project controls, as one group of the header bar.
   *
   * `min-w-0` on the box and on the group is what lets the picker be the part
   * that gives way: without it a flex item refuses to shrink below its content
   * and the bar wraps at the width the longest project name asks for.
   */
  const projectControls = (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {rename === null ? (
        <>
          <span className="relative inline-block max-w-72 min-w-0 flex-1">
            <Input
              className="h-8 w-full"
              aria-label="Project"
              role="combobox"
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
              title="Rename this project"
              onClick={() => {
                setRename({ projectId: selectedProject.id, draft: selectedProject.name });
              }}
            >
              ✎
            </Button>
          )}
        </>
      ) : (
        <Input
          className="h-8 max-w-72 min-w-0 flex-1"
          aria-label="Project name"
          value={rename.draft}
          // A callback ref rather than autoFocus: it fires when the node
          // attaches, which is the moment the button it replaces was clicked.
          ref={(element) => element?.focus()}
          onChange={(e) => {
            const draft = e.target.value;
            setRename((current) => (current === null ? current : { ...current, draft }));
          }}
          // Blur commits — the proposal's word — which also gives the rename
          // a mouse exit: click anywhere else and the mode resolves instead
          // of sitting open forever.
          onBlur={() => {
            commitOrCancelRename(rename);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitOrCancelRename(rename);
            }
            if (e.key === 'Escape') setRename(null);
          }}
        />
      )}
      <Button
        size="square"
        type="button"
        aria-label="New project"
        title="Start a new project"
        onClick={create}
      >
        +
      </Button>
    </div>
  );

  return (
    <>
      <AppHeader
        nav={nav}
        project={projectControls}
        presence={presence?.(selected)}
        account={account}
      />
      {/*
        The rest of the window, and a column flex so the frame below can have
        what the toolbar does not. `min-h-0` is the load-bearing half: a flex
        item's default `min-height: auto` refuses to shrink below its content,
        so without it the table's own height would push this box past the
        bottom of the screen and the frame would never be the thing that
        scrolls.
      */}
      <main className="flex min-h-0 flex-1 flex-col px-4 py-2">
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
          />
        )}
      </main>
    </>
  );
}
