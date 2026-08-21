import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AppHeader } from '@/components/chrome/app-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { CreatablePicker } from '@/components/wbs/creatable-picker';
import {
  type DirectoryApi,
  type DirectoryEffect,
  type DirectoryRefusal,
  directoryRefusalSentence,
  directoryRefusedWith,
  type DirectoryRemoval,
  type DirectoryUsage,
  type DirectoryWrite,
  httpDirectoryApi,
  type PersonView,
  type ServiceView,
  type TagView,
  type TeamView,
} from '@/lib/wbs-api';

export interface DirectoryPageProps {
  token: string;
  /** Injected in tests; the app lets it default to the real one. */
  api?: DirectoryApi;
  /** The two-page navigation, from router context. */
  nav?: ReactNode;
  /** The account menu, from router context. */
  account?: ReactNode;
}

/**
 * Which of the directory's four vocabularies a row belongs to.
 *
 * One name for what was three separate inline unions — `Confirming.kind`,
 * `commitRename`'s parameter and `askToRemove`'s — the moment a fourth arm
 * arrived. Two copies that agree are a fact; four are a chore.
 */
export type DirectoryKind = 'person' | 'team' | 'tag' | 'service';

/** A removal be-01 refused, and the decision the reader has not made yet. */
interface Confirming {
  kind: DirectoryKind;
  id: string;
  name: string;
  usage: DirectoryUsage;
}

/**
 * The **assumed assignee**'s name, or the word `null` stands for.
 *
 * `unassigned` is printed rather than left as a blank, because a removal that
 * takes a work item's sole assignee is exactly the thing somebody confirming
 * needs told — an absence in the sentence would read as "no change".
 */
const assumedName = (name: string | null): string => name ?? 'unassigned';

/**
 * Where one effect is being printed: the row it is listed under, and how to
 * name another row of the same confirmation.
 *
 * `capacity_released` is the arm that needs it. The payload names the row whose
 * label puts this one on the pool, and where that is an ancestor the sentence
 * has to say so — a bare "no longer limited to 4 at a time" on a row carrying
 * no label reads as a claim about a write that will not happen there.
 */
export interface EffectContext {
  /** The work item this effect is listed under. */
  workItemId: string;
  /**
   * Which vocabulary the entry being removed belongs to.
   *
   * `label_removed` is the arm that needs it, and it needs it because be-01
   * emits that **one** kind for two dimensions: a tag's labelling row and,
   * since task 10.2, a service's. The payload carries no discriminator — the
   * kind says what happened to the labelling row, not which vocabulary it was —
   * so the confirmation reads it off the removal the reader actually asked for.
   *
   * Without this, removing a service confirmed with a sentence about tags.
   */
  removing: DirectoryKind;
  /**
   * `010 Backend` for a row id, or null where the confirmation does not list
   * it.
   *
   * Null is reachable and modeled rather than thrown on: the usage payload
   * lists the rows a removal *touches*, and a labelled ancestor whose own
   * effects are empty need not be among them.
   */
  rowNamed: (id: string) => string | null;
}

/**
 * What one effect of a removal does, in the words of somebody reading a plan.
 *
 * Built from the payload's own `kind` and nothing else: be-01 names each arm
 * **and what that arm does** precisely so this page never has to derive an
 * impact from a count.
 */
export function effectSentence(effect: DirectoryEffect, on: EffectContext): string {
  switch (effect.kind) {
    case 'assignment_dropped':
      return `The ${effect.role.name} assignment goes.`;
    case 'label_nulled':
      return 'The service team label is cleared.';
    case 'label_removed':
      // Its own sentence and not the team's, because nothing is *cleared*:
      // neither dimension has a column to null, so what goes is the labelling
      // row itself. And it says what these two removals cannot do — no dates
      // move — because the sentence beside it for a team says they may, and a
      // reader comparing the two confirmations is entitled to the difference.
      //
      // Named off `removing` rather than off the effect: `label_removed` is
      // what be-01 sends for a tag **and** for a service, and a confirmation
      // that answered "the tag comes off this item" to somebody removing
      // `Payments` would be naming a dimension they never touched.
      return `The ${on.removing === 'service' ? 'service' : 'tag'} comes off this item. No dates move.`;
    case 'capacity_released':
      // Two sentences from one arm, and the split is `fromId` against the row
      // it is listed under — be-01's own way of saying "inherited" without a
      // second flag beside it. A row that inherits the label loses a bound it
      // never carried, and a confirmation saying "the label is cleared" about
      // it would be describing a write that never happens there.
      return effect.fromId === on.workItemId
        ? `No longer limited to ${String(effect.size)} at a time. Dates may move earlier.`
        : `No longer limited to ${String(effect.size)} at a time — the limit it inherits from ${
            on.rowNamed(effect.fromId) ?? 'a row above it'
          }. Dates may move earlier.`;
    case 'assumed_assignee_changed':
      return `Assumed to be doing all of it: ${assumedName(effect.assumedNow)} now, ${assumedName(
        effect.assumedAfter,
      )} afterwards.`;
  }
}

/** How many of a thing, named singly or plurally — `1 member`, `2 members`. */
const count = (howMany: number, thing: string): string =>
  `${String(howMany)} ${thing}${howMany === 1 ? '' : 's'}`;

/**
 * Every control a thumb has to hit is 44px in both dimensions, which the phone
 * spec asserts **as rendered** rather than assumes.
 *
 * `h-11` is 2.75rem, which is 44 at the root font size this app never changes.
 * The picker's own `<input>` carries no class of its own — it is a shared
 * component the table renders too, and the change proposal rules a change to it
 * out — so the height is reached through a descendant variant on the box around
 * it. `e2e/directory.spec.ts` measures the boxes; nothing here is trusted.
 */
const TAP = 'h-11';
const TAP_SQUARE = 'h-11 w-11 shrink-0 p-0';
const TAP_PICKER = '[&_input]:h-11 [&_input]:rounded-md [&_input]:border [&_input]:px-2';

/**
 * The directory: every person, team, tag and service on this deployment.
 *
 * It renders its own {@link AppHeader}, which is the contract
 * `openspec/changes/directory-page/` pins — the account and the navigation come
 * from router context, and the project controls stay in `ProjectPage`, which
 * owns the picker's list, its selection and the rename in progress. A header
 * drawn once above both routes would have to reach back into the project page
 * for state it does not hold, and the two pages disagree about what the bar
 * carries.
 *
 * **No socket.** This page opens no subscription of its own: it re-reads on
 * arrival, after each of its own writes, and when the window is focused or the
 * tab becomes visible again. A change somebody else makes while it sits open
 * and focused is therefore seen on the next of those rather than the moment it
 * happens — a stated cost. `directory_changed` reaching open projects is
 * `directory-crud`'s job and not this page's.
 *
 * **Nothing here is optimistic.** Every write re-reads and both panels redraw
 * from what came back, so a refused change leaves the screen as it was with the
 * refusal on it.
 */
export function DirectoryPage({ token, api: apiOverride, nav, account }: DirectoryPageProps) {
  const directory = useMemo(() => apiOverride ?? httpDirectoryApi(token), [apiOverride, token]);

  const [people, setPeople] = useState<PersonView[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [tags, setTags] = useState<TagView[]>([]);
  const [newTag, setNewTag] = useState('');
  const [services, setServices] = useState<ServiceView[]>([]);
  const [newService, setNewService] = useState('');
  const [problem, setProblem] = useState<DirectoryRefusal | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPerson, setNewPerson] = useState('');
  const [newTeam, setNewTeam] = useState('');
  /**
   * The names being typed over the directory's own, by entry id.
   *
   * Only the ones somebody has touched: an entry absent from here reads as
   * be-01 has it, so a person renamed elsewhere redraws rather than being held
   * at the name this browser last read.
   */
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  /**
   * The chip to put the focus on once the panels have redrawn, or null.
   *
   * A ref rather than state: it is read once, in the effect that watches the
   * redraw, and a re-render of its own would be a second one for every keyboard
   * removal.
   */
  const focusChipAfterRedraw = useRef<string | null>(null);
  const chipNodes = useRef(new Map<string, HTMLButtonElement>());
  const chipKey = (personId: string, teamId: string): string => `${personId}:${teamId}`;

  /**
   * The read entitled to write the screen — `wbs-table.tsx`'s `latestRefresh`,
   * for its reason and one more of this page's own.
   *
   * Three call sites fire {@link read} and none is gated on the others:
   * arrival, `window.focus` and `visibilitychange`. Two of them overlap the
   * moment somebody switches windows twice, they finish in whatever order the
   * network gives them, and an earlier one landing last would replace the
   * panels with a directory older than what is on screen — with nothing
   * guaranteed to arrive afterwards and repair it.
   *
   * The page being non-optimistic does not cover this: that is an argument
   * about **writes**, and every write here re-reads. The hazard is in the
   * reads.
   *
   * C3 had a second, sharper reason here — `commitSize` short-circuited on the
   * size it believed be-01 held, so typing what a stale screen showed sent
   * nothing at all. That box moved to the plan's own `TeamsDialog` in
   * `capacity-per-project`, and the short-circuit went with it. The guard stays:
   * the stale-name hazard is enough on its own, and every one of the three call
   * sites is still ungated without it.
   */
  const latestRead = useRef(0);

  const read = useCallback(async () => {
    const generation = latestRead.current + 1;
    latestRead.current = generation;
    const [foundPeople, foundTeams, foundTags, foundServices] = await Promise.all([
      directory.listPeople(),
      directory.listTeams(),
      directory.listTags(),
      directory.listServices(),
    ]);
    // Proof: this line deleted, `and only the newest read may write the screen`
    // alone failed, on `expected null not to be null` — a superseded read
    // putting the name somebody had just changed back on the panel. Watched
    // 2026-08-13.
    if (generation !== latestRead.current) return;
    setPeople(foundPeople);
    setTeams(foundTeams);
    setTags(foundTags);
    setServices(foundServices);
  }, [directory]);

  const reportFailedRead = useCallback((thrown: unknown) => {
    setProblem(directoryRefusedWith(thrown));
  }, []);

  // Arrival.
  useEffect(() => {
    void read().catch(reportFailedRead);
  }, [read, reportFailedRead]);

  /**
   * Coming back to the page, by either of the two ways a browser reports it.
   *
   * Both, because they are not the same event: `focus` fires for a window
   * brought forward, and `visibilitychange` for a tab switched back to inside a
   * window that never lost focus. A page that sat open all afternoon would
   * otherwise still be showing the morning's directory, which is the whole
   * reason arrival alone was not enough.
   */
  useEffect(() => {
    const again = () => {
      void read().catch(reportFailedRead);
    };
    const whenVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', whenVisible);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', whenVisible);
    };
  }, [read, reportFailedRead]);

  /**
   * Puts the focus on the chip a keyboard removal left, once the panels have
   * redrawn **and** the controls are live again.
   *
   * `busy` is a dependency rather than noise: the redraw lands one render
   * before the write finishes, and every chip is `disabled` until it does — and
   * `focus()` on a disabled button does nothing at all, silently. Watched: with
   * `[people]` alone, `are removable from the keyboard, and the focus lands on
   * the neighbour` failed with the focus on `<body>`.
   */
  useEffect(() => {
    const wanted = focusChipAfterRedraw.current;
    if (wanted === null || busy) return;
    focusChipAfterRedraw.current = null;
    const node = chipNodes.current.get(wanted);
    // A neighbour that is no longer on screen means the redraw disagreed with
    // what was on it a moment ago — somebody else edited this person. That is a
    // state rather than a fault, and moving the focus somewhere arbitrary would
    // be worse than leaving it where the browser put it.
    if (node !== undefined) node.focus();
  }, [people, busy]);

  /**
   * Runs one directory change, reports what refused it, and re-reads either way.
   *
   * Re-reads on the refusal too: a `taken` leaves the entry exactly as be-01
   * has it, and redrawing from the answer is what puts the surviving name back
   * on the panel rather than leaving the typed one sitting there looking
   * accepted.
   */
  const attempt = useCallback(
    async (change: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setProblem(null);
      try {
        await change();
      } catch (thrown: unknown) {
        setProblem(directoryRefusedWith(thrown));
      }
      try {
        await read();
      } catch (thrown: unknown) {
        reportFailedRead(thrown);
      } finally {
        setBusy(false);
      }
    },
    [read, reportFailedRead],
  );

  const withoutDraft = (current: Record<string, string>, id: string): Record<string, string> =>
    Object.fromEntries(Object.entries(current).filter(([at]) => at !== id));

  /**
   * Drops both drafts for one entry, which is what a **commit** leaves behind.
   *
   * Both, and deliberately: a write to either box refetches the whole
   * directory, so a draft left standing over a value that has just come back
   * would hold the box at what this browser typed and hide what be-01 answered.
   *
   * Escape is the other way a draft goes — {@link forgetNameDraft}, which since
   * `capacity-per-project` is the only draft this page holds: the size box that
   * made these two functions two moved to the plan's own `TeamsDialog`.
   */
  const forgetDraft = (id: string) => {
    setRenamed((current) => withoutDraft(current, id));
  };

  const forgetNameDraft = (id: string) => {
    setRenamed((current) => withoutDraft(current, id));
  };

  const nameShown = (entry: { id: string; name: string }): string =>
    renamed[entry.id] ?? entry.name;

  /**
   * What renaming and removing mean for each vocabulary, in **one** place.
   *
   * `commitRename`, `askToRemove` and `confirmRemoval` each carried a copy of
   * the same three-branch ternary over `kind`, and the copies agreed. A fourth
   * arm is where that agreement stops being a fact about the code and becomes
   * something somebody has to keep true in three places — the argument task 7.4
   * settled for the export's three label cells, one screen over.
   *
   * The entry type is narrowed to `{ id; name }` on purpose: these two call
   * sites read `ok` and `survivingName` and nothing else, and a person, a team,
   * a tag and a service differ in ways no caller here looks at.
   */
  const writesFor: Record<
    DirectoryKind,
    {
      rename: (id: string, name: string) => Promise<DirectoryWrite<{ id: string; name: string }>>;
      remove: (id: string, cascade: boolean) => Promise<DirectoryRemoval>;
    }
  > = {
    // A person's rename is a **patch** and so is a team's since 7.5 — both
    // entities have a second field on the same route — while a tag and a
    // service have nothing but a name. That difference is the reason this is a
    // map rather than a naming convention.
    person: {
      rename: (id, name) => directory.patchPerson(id, { name }),
      remove: (id, cascade) => directory.removePerson(id, cascade),
    },
    team: {
      rename: (id, name) => directory.patchTeam(id, { name }),
      remove: (id, cascade) => directory.removeTeam(id, cascade),
    },
    tag: {
      rename: (id, name) => directory.renameTag(id, name),
      remove: (id, cascade) => directory.removeTag(id, cascade),
    },
    service: {
      rename: (id, name) => directory.renameService(id, name),
      remove: (id, cascade) => directory.removeService(id, cascade),
    },
  };

  /**
   * Sends the name typed over an entry's, if it says something different.
   *
   * A name of whitespace alone never leaves this page: the answer is the same
   * either way and this one arrives without a round trip, which is what the
   * scenario "nothing is sent and the page says the name is empty" asks for.
   *
   * Proof: this guard removed, `sends nothing when the name is whitespace
   * alone, and says so` failed on `Unable to find role="alert"`, with
   * `patchPerson` having been called `{ name: '' }`. Watched 2026-08-09.
   */
  function commitRename(kind: DirectoryKind, entry: { id: string; name: string }): void {
    const clean = nameShown(entry).trim();
    if (clean === '') {
      setProblem({ reason: 'refused', code: 'name_required' });
      return;
    }
    if (clean === entry.name) {
      forgetDraft(entry.id);
      return;
    }
    void attempt(async () => {
      const written = await writesFor[kind].rename(entry.id, clean);
      forgetDraft(entry.id);
      if (!written.ok) {
        setProblem({ reason: 'taken', survivingName: written.survivingName });
      }
    });
  }

  /*
    `sizeShown` and `commitSize` lived here, with C3's whole argument about what
    an empty box and a non-finite draft mean. They are in
    `components/wbs/teams-dialog.tsx` now, because the number is one plan's rather
    than the deployment's — `capacity-per-project`, Dany 2026-08-13, design.md D5.
    The two local decisions and both of their watched negatives moved with them.
  */

  /** Sets exactly the teams a person belongs to — the set the chips show. */
  function setMemberships(person: PersonView, teamIds: readonly string[]): void {
    void attempt(async () => {
      const written = await directory.patchPerson(person.id, { teamIds });
      if (!written.ok) {
        setProblem({ reason: 'taken', survivingName: written.survivingName });
      }
    });
  }

  /** The teams a person is in, in be-01's own order rather than the order they joined. */
  const teamsOf = (person: PersonView): TeamView[] =>
    teams.filter((team) => person.teamIds.includes(team.id));

  /**
   * The chip the focus should land on once `teamId`'s has gone: the next one,
   * or the one before it when the last chip is the one leaving.
   */
  function neighbourChip(person: PersonView, teamId: string): string | null {
    const held = teamsOf(person);
    const at = held.findIndex((team) => team.id === teamId);
    // Written out rather than `held.at(at + 1) ?? held.at(at - 1)`, which from
    // the **first** chip answers the last one — and from a person with one
    // membership answers the chip that is leaving.
    if (at === -1) return null;
    if (at + 1 < held.length) return chipKey(person.id, held[at + 1]?.id ?? '');
    if (at > 0) return chipKey(person.id, held[at - 1]?.id ?? '');
    return null;
  }

  function removeMembership(person: PersonView, teamId: string): void {
    setMemberships(
      person,
      person.teamIds.filter((held) => held !== teamId),
    );
  }

  function submitNewPerson(event: FormEvent): void {
    event.preventDefault();
    const clean = newPerson.trim();
    if (clean === '') {
      setProblem({ reason: 'refused', code: 'name_required' });
      return;
    }
    void attempt(async () => {
      await directory.addPerson(clean, []);
      setNewPerson('');
    });
  }

  function submitNewTeam(event: FormEvent): void {
    event.preventDefault();
    const clean = newTeam.trim();
    if (clean === '') {
      setProblem({ reason: 'refused', code: 'name_required' });
      return;
    }
    void attempt(async () => {
      await directory.addTeam(clean);
      setNewTeam('');
    });
  }

  /**
   * Adds a tag — {@link submitNewTeam}'s shape, and the surface tags are made
   * on at all.
   *
   * The plan's own tag cell deliberately cannot create one (`tags`' non-goal):
   * a typo made in a cell becomes a second spelling of something that already
   * exists, and this page is where a reader can see the whole vocabulary and
   * rename the mistake.
   */
  function submitNewTag(event: FormEvent): void {
    event.preventDefault();
    const clean = newTag.trim();
    if (clean === '') {
      setProblem({ reason: 'refused', code: 'name_required' });
      return;
    }
    void attempt(async () => {
      await directory.addTag(clean);
      setNewTag('');
    });
  }

  /**
   * Adds a service — {@link submitNewTag}'s shape and its argument, one
   * dimension over.
   *
   * The plan's own service cell cannot create one either (`service-split`
   * task 7.1's non-goal): this page is where a reader sees the whole vocabulary
   * at once and can rename `Payements` rather than living beside it.
   */
  function submitNewService(event: FormEvent): void {
    event.preventDefault();
    const clean = newService.trim();
    if (clean === '') {
      setProblem({ reason: 'refused', code: 'name_required' });
      return;
    }
    void attempt(async () => {
      await directory.addService(clean);
      setNewService('');
    });
  }

  /**
   * Asks for a removal **without** a cascade, which is always the first ask.
   *
   * be-01 removes an entry nothing points at outright and refuses one that is
   * used, with the **directory usage**. Sending the cascade on the first ask
   * would remove the thing and then show somebody what it took.
   *
   * Proof: the two `false`s here pinned to `true`, **six** cases failed —
   * five on `Unable to find role="dialog"` (no confirmation ever drawn) and
   * `removes an entry nothing points at on the first request` on
   * `expected [ [ 't2', true ] ] to deeply equal [ [ 't2', false ] ]`. The
   * fault `phases-dialog` already knows. Watched 2026-08-09.
   */
  function askToRemove(kind: DirectoryKind, entry: { id: string; name: string }): void {
    void attempt(async () => {
      const outcome = await writesFor[kind].remove(entry.id, false);
      if (outcome.ok) return;
      setConfirming({ kind, id: entry.id, name: entry.name, usage: outcome.usage });
    });
  }

  function confirmRemoval(): void {
    if (confirming === null) return;
    const asked = confirming;
    void attempt(async () => {
      const outcome = await writesFor[asked.kind].remove(asked.id, true);
      // A second `in_use` against a confirmed cascade is be-01 refusing what it
      // just described; there is nothing left to confirm against, so it is
      // raised rather than turned into a second dialog.
      if (!outcome.ok) throw new Error('in_use');
      setConfirming(null);
    });
  }

  /**
   * Sets exactly the services a team is responsible for — {@link setMemberships}
   * one entity over, and a **full replacement** for its reason.
   *
   * This writes the ownership map and nothing else. It labels no work item, it
   * moves no date and it is not the row's service: a team owning `Payments`
   * says who is responsible for it, and a row delivering `Payments` says what
   * that row is part of. The two meeting is exactly the *built by a non-owner*
   * signal, which reads this map rather than being written into it.
   */
  function setOwnedServices(team: TeamView, serviceIds: readonly string[]): void {
    void attempt(async () => {
      const written = await directory.patchTeam(team.id, { serviceIds });
      if (!written.ok) {
        setProblem({ reason: 'taken', survivingName: written.survivingName });
      }
    });
  }

  /**
   * The services a team owns, in the **directory's** order rather than the
   * order somebody claimed them — {@link teamsOf}'s rule, so two teams owning
   * the same pair list them the same way round.
   */
  const servicesOf = (team: TeamView): ServiceView[] =>
    services.filter((service) => (team.serviceIds ?? []).includes(service.id));

  const membersOf = (team: TeamView): number =>
    people.filter((person) => person.teamIds.includes(team.id)).length;

  return (
    <>
      <AppHeader nav={nav} account={account} />
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <h2 className="sr-only">Directory</h2>
        {problem !== null && (
          <p role="alert" className="text-destructive text-sm">
            {directoryRefusalSentence(problem)}
          </p>
        )}
        {/*
          One column below 768px and two at and above it. `md` is Tailwind's 768
          — the same number `app-header.tsx` stops wrapping at and
          `plan-renderer.ts` swaps the renderer at, deliberately the same one.
        */}
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-4">
              {people.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nobody is in the directory yet. Add the first person below.
                </p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {people.map((person) => (
                    <li key={person.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <Input
                          className={`${TAP} min-w-0 flex-1`}
                          aria-label={`Name of ${person.name}`}
                          value={nameShown(person)}
                          disabled={busy}
                          onChange={(event) => {
                            const typed = event.currentTarget.value;
                            setRenamed((current) => ({ ...current, [person.id]: typed }));
                          }}
                          onBlur={() => {
                            commitRename('person', person);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              commitRename('person', person);
                            }
                            if (event.key === 'Escape') forgetDraft(person.id);
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className={TAP_SQUARE}
                          aria-label={`Remove ${person.name}`}
                          disabled={busy}
                          onClick={() => {
                            askToRemove('person', person);
                          }}
                        >
                          <span aria-hidden="true">✕</span>
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {teamsOf(person).map((team) => (
                          <button
                            key={team.id}
                            type="button"
                            data-chip={chipKey(person.id, team.id)}
                            ref={(node) => {
                              const key = chipKey(person.id, team.id);
                              if (node === null) chipNodes.current.delete(key);
                              else chipNodes.current.set(key, node);
                            }}
                            aria-label={`Remove ${team.name} from ${person.name}`}
                            className="border-input bg-background hover:bg-accent inline-flex min-h-11 min-w-11 shrink-0 items-center gap-1 rounded-full border px-3 text-sm"
                            disabled={busy}
                            onClick={() => {
                              removeMembership(person, team.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Delete' && event.key !== 'Backspace') return;
                              // Taken from the browser as well as from the
                              // page: Backspace on a page with nothing focused
                              // is a "back" on some browsers, and a chip is
                              // very much focused here.
                              event.preventDefault();
                              focusChipAfterRedraw.current = neighbourChip(person, team.id);
                              removeMembership(person, team.id);
                            }}
                          >
                            {team.name}
                            <span aria-hidden="true">✕</span>
                          </button>
                        ))}
                        <span className={`inline-flex min-w-40 flex-1 ${TAP_PICKER}`}>
                          <CreatablePicker
                            label={`Add a team for ${person.name}`}
                            // Only what they are **not** already in. Offering a
                            // team they hold is how a duplicate membership is
                            // sent, and be-01 would take it.
                            entries={teams.filter((team) => !person.teamIds.includes(team.id))}
                            // Single-select, held at null on purpose: this
                            // picker is being used as what it is — one choose
                            // adds one membership, and the chips are the set.
                            value={null}
                            placeholder="Add a team…"
                            onChoose={(teamId) => {
                              setMemberships(person, [...person.teamIds, teamId]);
                            }}
                            onCreate={(name) => {
                              void attempt(async () => {
                                const team = await directory.addTeam(name);
                                const written = await directory.patchPerson(person.id, {
                                  teamIds: [...person.teamIds, team.id],
                                });
                                if (!written.ok) {
                                  setProblem({
                                    reason: 'taken',
                                    survivingName: written.survivingName,
                                  });
                                }
                              });
                            }}
                            onClear={() => {
                              // Unreachable: the ✕ is drawn only for a chosen
                              // entry and this picker holds none. The chips are
                              // what clears a membership.
                            }}
                          />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form className="flex items-center gap-2" onSubmit={submitNewPerson}>
                <Input
                  className={`${TAP} min-w-0 flex-1`}
                  aria-label="New person"
                  placeholder="Name"
                  value={newPerson}
                  disabled={busy}
                  onChange={(event) => {
                    setNewPerson(event.currentTarget.value);
                  }}
                />
                <Button type="submit" className={TAP} disabled={busy}>
                  Add person
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Service teams</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-4">
              {teams.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No service teams yet. Add the first one below.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {teams.map((team) => (
                    <li key={team.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <Input
                          className={`${TAP} min-w-0 flex-1`}
                          aria-label={`Name of ${team.name}`}
                          value={nameShown(team)}
                          disabled={busy}
                          onChange={(event) => {
                            const typed = event.currentTarget.value;
                            setRenamed((current) => ({ ...current, [team.id]: typed }));
                          }}
                          onBlur={() => {
                            commitRename('team', team);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              commitRename('team', team);
                            }
                            if (event.key === 'Escape') forgetNameDraft(team.id);
                          }}
                        />
                        {/*
                        No size box. How many of a team are at work at once is a
                        fact about one **plan** since `capacity-per-project`
                        (Dany, 2026-08-13: "The global number should not matter,
                        only per project capacity configuration matters"), and
                        this page has no plan — a box here could only have meant
                        "the plan you last had open", which reads as global and is
                        not. It is the `Teams` dialog in the plan's own toolbar.

                        Removed rather than disabled or left showing a number from
                        somewhere: a control that writes a value no schedule reads
                        is worse than no control at all. design.md D4 and D5.
                      */}
                        <span className="text-muted-foreground shrink-0 text-sm">
                          {count(membersOf(team), 'member')}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          className={TAP_SQUARE}
                          aria-label={`Remove ${team.name}`}
                          disabled={busy}
                          onClick={() => {
                            askToRemove('team', team);
                          }}
                        >
                          <span aria-hidden="true">✕</span>
                        </Button>
                      </div>
                      {/*
                        **The ownership map, and the team row is where it is
                        edited** — Dany, 2026-08-20 23:18: "one team can be
                        responsible for several services - it must be
                        configurable in the directory."

                        On the team row rather than on the Services card,
                        because a list of teams drawn under a service would read
                        as a property of the service — and a service that
                        "has" teams is one step from a service that schedules
                        them, which decision 2 rules out.

                        The person row's membership chips, reused as they stand:
                        one picker adds one claim, the chips are the set, and
                        the ✕ takes one off. What it deliberately does **not**
                        carry is the person row's Delete/Backspace focus walk —
                        see the code below.
                      */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground shrink-0 text-sm">
                          Responsible for
                        </span>
                        {servicesOf(team).map((service) => (
                          <button
                            key={service.id}
                            type="button"
                            aria-label={`${team.name} no longer owns ${service.name}`}
                            className="border-input bg-background hover:bg-accent inline-flex min-h-11 min-w-11 shrink-0 items-center gap-1 rounded-full border px-3 text-sm"
                            disabled={busy}
                            onClick={() => {
                              setOwnedServices(
                                team,
                                (team.serviceIds ?? []).filter((held) => held !== service.id),
                              );
                            }}
                          >
                            {service.name}
                            <span aria-hidden="true">✕</span>
                          </button>
                        ))}
                        {/*
                          **No Delete/Backspace focus walk here**, stated rather
                          than forgotten. Each chip is a button, so a keyboard
                          removes one with Enter or Space; what is missing is
                          the person row's move-to-the-neighbour afterwards,
                          which needs `neighbourChip` and it is written against
                          a person's own membership list. A second copy for a
                          second dimension is the thing tasks 7.4 and 7.5 have
                          twice folded rather than duplicated, and generalising
                          it is its own change.
                        */}
                        <span className={`inline-flex min-w-40 flex-1 ${TAP_PICKER}`}>
                          <CreatablePicker
                            label={`Make ${team.name} responsible for a service`}
                            // Only what it does **not** already own: offering a
                            // service it holds is how a duplicate claim is sent.
                            entries={services.filter(
                              (service) => !(team.serviceIds ?? []).includes(service.id),
                            )}
                            value={null}
                            placeholder="Add a service…"
                            onChoose={(serviceId) => {
                              setOwnedServices(team, [...(team.serviceIds ?? []), serviceId]);
                            }}
                            onCreate={(name) => {
                              void attempt(async () => {
                                const service = await directory.addService(name);
                                const written = await directory.patchTeam(team.id, {
                                  serviceIds: [...(team.serviceIds ?? []), service.id],
                                });
                                if (!written.ok) {
                                  setProblem({
                                    reason: 'taken',
                                    survivingName: written.survivingName,
                                  });
                                }
                              });
                            }}
                            onClear={() => {
                              // Unreachable, `Add a team for …`'s reason: the ✕
                              // is drawn for a chosen entry and this picker
                              // holds none. The chips are what clears a claim.
                            }}
                          />
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form className="flex items-center gap-2" onSubmit={submitNewTeam}>
                <Input
                  className={`${TAP} min-w-0 flex-1`}
                  aria-label="New service team"
                  placeholder="Name"
                  value={newTeam}
                  disabled={busy}
                  onChange={(event) => {
                    setNewTeam(event.currentTarget.value);
                  }}
                />
                <Button type="submit" className={TAP} disabled={busy}>
                  Add team
                </Button>
              </form>
            </CardContent>
          </Card>

          {/*
            Tags: a **sibling** section beside Service teams rather than a second
            tab of it, and what makes that the right shape is what is missing
            from every row below.

            **No capacity column and no membership chips.** A team row carries a
            member count because people belong to teams and a removal takes those
            memberships with it; nobody belongs to a tag. A team's *size* is a
            fact about one plan and lives in that plan's own dialog; a tag has no
            size anywhere, in this page or in the schema, and never had one.

            That visible absence is the model rule taught rather than stated: a
            reader who notices this section has one fewer column than the one
            above it has learned that a tag says what kind of thing the work is
            and nothing about who does it or how fast.
          */}
          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-4">
              {tags.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No tags yet. Add the first one below — the plan&rsquo;s Tags column appears once
                  one exists.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {tags.map((tag) => (
                    <li key={tag.id} className="flex items-center gap-2">
                      <Input
                        className={`${TAP} min-w-0 flex-1`}
                        aria-label={`Name of ${tag.name}`}
                        value={nameShown(tag)}
                        disabled={busy}
                        onChange={(event) => {
                          const typed = event.currentTarget.value;
                          setRenamed((current) => ({ ...current, [tag.id]: typed }));
                        }}
                        onBlur={() => {
                          commitRename('tag', tag);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitRename('tag', tag);
                          }
                          if (event.key === 'Escape') forgetNameDraft(tag.id);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className={TAP_SQUARE}
                        aria-label={`Remove ${tag.name}`}
                        disabled={busy}
                        onClick={() => {
                          askToRemove('tag', tag);
                        }}
                      >
                        <span aria-hidden="true">✕</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="flex items-center gap-2" onSubmit={submitNewTag}>
                <Input
                  className={`${TAP} min-w-0 flex-1`}
                  aria-label="New tag"
                  placeholder="Name"
                  value={newTag}
                  disabled={busy}
                  onChange={(event) => {
                    setNewTag(event.currentTarget.value);
                  }}
                />
                <Button type="submit" className={TAP} disabled={busy}>
                  Add tag
                </Button>
              </form>
            </CardContent>
          </Card>

          {/*
            Services: the third sibling, and it has the Tags card's shape for
            the Tags card's reason — **no capacity column and no membership
            chips**.

            The absence is a different one again, and it is the point of putting
            this card here rather than inside the Service teams card above.
            Nobody belongs to a service and a service is not a pool: it is what
            the work is *part of*, and who has the people is still a team. A
            reader who sees two columns here and three above has been taught
            Dany's 2026-08-20 23:16 ruling — service and team are independent —
            by the screen rather than by a sentence.

            Which services a team is **responsible for** is the one place the
            two meet, and it is edited on the team row above (task 7.5's second
            half), not here: an ownership map drawn on this card would read as a
            property of the service.
          */}
          <Card>
            <CardHeader>
              <CardTitle>Services</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 pt-4">
              {services.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No services yet. Add the first one below — the plan&rsquo;s Services column
                  appears once one exists.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {services.map((service) => (
                    <li key={service.id} className="flex items-center gap-2">
                      <Input
                        className={`${TAP} min-w-0 flex-1`}
                        aria-label={`Name of ${service.name}`}
                        value={nameShown(service)}
                        disabled={busy}
                        onChange={(event) => {
                          const typed = event.currentTarget.value;
                          setRenamed((current) => ({ ...current, [service.id]: typed }));
                        }}
                        onBlur={() => {
                          commitRename('service', service);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitRename('service', service);
                          }
                          if (event.key === 'Escape') forgetNameDraft(service.id);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className={TAP_SQUARE}
                        aria-label={`Remove ${service.name}`}
                        disabled={busy}
                        onClick={() => {
                          askToRemove('service', service);
                        }}
                      >
                        <span aria-hidden="true">✕</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form className="flex items-center gap-2" onSubmit={submitNewService}>
                <Input
                  className={`${TAP} min-w-0 flex-1`}
                  aria-label="New service"
                  placeholder="Name"
                  value={newService}
                  disabled={busy}
                  onChange={(event) => {
                    setNewService(event.currentTarget.value);
                  }}
                />
                <Button type="submit" className={TAP} disabled={busy}>
                  Add service
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>

      {/*
        Closing drops the confirmation rather than remembering it: the next
        removal asks again without a cascade, because a dialog somebody walked
        away from is not one they agreed to.
      */}
      <Modal
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        {confirming !== null && (
          <ModalContent>
            <ModalHeader>
              <ModalTitle>Remove {confirming.name}?</ModalTitle>
              <ModalDescription>
                This is what would go with {confirming.name}. Nothing has been removed yet.
              </ModalDescription>
            </ModalHeader>
            {/*
              Scrolls inside itself. A usage naming forty work items would
              otherwise push the two buttons off the bottom of the surface, and
              a confirmation whose confirm cannot be reached is a dead end.
            */}
            <div className="flex max-h-64 flex-col gap-3 overflow-y-auto text-sm">
              {confirming.usage.projects.map((project) => (
                <div key={project.id} className="flex flex-col gap-1">
                  <h3 className="font-semibold">{project.name}</h3>
                  <ul className="flex flex-col gap-1">
                    {project.workItems.map((workItem) => (
                      <li key={workItem.id}>
                        <span className="font-medium">
                          {workItem.number} {workItem.name}
                        </span>
                        <ul className="text-muted-foreground pl-4">
                          {workItem.effects.map((effect) => (
                            <li key={`${workItem.id}:${effect.kind}`}>
                              {effectSentence(effect, {
                                workItemId: workItem.id,
                                // The dimension the reader asked to remove.
                                // `label_removed` arrives for a tag and for a
                                // service alike and says which of the two
                                // nowhere, so the sentence takes it from here.
                                removing: confirming.kind,
                                // Named out of the **same project**, which is
                                // the only list a row id in this payload can
                                // mean: two projects may each hold a row
                                // numbered `010`, and resolving across all of
                                // them would name the wrong one.
                                rowNamed: (id) => {
                                  const named = project.workItems.find((each) => each.id === id);
                                  return named === undefined
                                    ? null
                                    : `${named.number} ${named.name}`;
                                },
                              })}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {confirming.usage.members.length > 0 && (
                <div className="flex flex-col gap-1">
                  <h3 className="font-semibold">These people would lose a membership</h3>
                  <ul className="text-muted-foreground">
                    {confirming.usage.members.map((member) => (
                      <li key={member.id}>{member.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <ModalFooter>
              <Button
                type="button"
                variant="outline"
                className={TAP}
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Keep {confirming.name}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className={TAP}
                disabled={busy}
                onClick={confirmRemoval}
              >
                Remove {confirming.name} and all of that
              </Button>
            </ModalFooter>
          </ModalContent>
        )}
      </Modal>
    </>
  );
}
