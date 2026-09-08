import { effectiveServicesOf } from '@wbs/domain/effective-service';
import { effectiveTagsOf } from '@wbs/domain/effective-tag';
import type { EffectiveTeams } from '@wbs/domain/effective-team';
import { effectiveTeamsOf } from '@wbs/domain/effective-team';
import { assignedOutsideTeam, builtByNonOwner } from '@wbs/domain/label-mismatch';
import { useCallback, useMemo } from 'react';

import type { PersonView, ServiceView, TagView, TeamView } from '@/lib/wbs-api';
import { type EstimateMethod, type ProjectApi } from '@/lib/wbs-api';

import { type ExternalRefDraft } from './external-refs-modal';
import {
  type InheritedTagLabel,
  type ServiceLabel,
  type ServiceTeamLabel,
  type TagLabel,
} from './gantt-geometry';
import { type CommitOutcome } from './live-editing';
import { type CardAssignee } from './plan-cards';
import { assignedSteps, indexById } from './plan-indexes';
import { assigneesOf, listed, MISMATCH_TAIL } from './plan-mismatch';
import { type TreeRow } from './wbs-rows';
import { rowWords } from './work-item-words';

/**
 * The four vocabularies a row can be labelled from — teams, tags, services,
 * work-item types — as the lists the pickers offer.
 *
 * Read beside the tree rather than derived from it: a label the plan does not
 * use yet is still a label somebody may pick.
 */
export function usePlanLabels({
  flat,
  teams,
  tags,
  services,
  people,
}: {
  flat: TreeRow[];
  teams: TeamView[];
  tags: TagView[];
  services: ServiceView[];
  people: PersonView[];
}) {
  /**
   * Every work item in the plan, named the way a dependency names one.
   *
   * **`flat` and not `shownRows`**, and that is the whole of this lookup: a
   * collapsed branch and a search each hide rows a dependency may point at, and
   * a bar saying it waits for something it cannot name is a bar saying nothing.
   * The chart draws what is on screen; what it *says* is drawn from the tree.
   *
   * `<number> <name>` is how the plan names a predecessor out loud — the same
   * words the Depends on chips carry. An unnamed row keeps the number it does
   * have, which is why the empty name has words rather than a trailing space.
   */
  const namedInTheTree = useMemo(
    () => new Map(flat.map((row) => [row.id, rowWords(row.number, row.name)])),
    [flat],
  );

  /**
   * The three directory vocabularies as lookups.
   *
   * The label readings below asked `teams.find(...)`, `tags.find(...)` and
   * `services.find(...)` **per row**, and the chart's input calls all three for
   * every row it draws — so naming a plan's labels was O(rows × directory) three
   * times over. They change when a directory read lands, which is rarely.
   */
  const teamsById = useMemo(() => indexById(teams), [teams]);

  const tagsById = useMemo(() => indexById(tags), [tags]);

  const servicesById = useMemo(() => indexById(services), [services]);

  /**
   * The service team a work item is labelled with, resolved against the
   * directory read this client holds.
   *
   * The two are different moments — the label comes with the tree and the teams
   * from their own request — so a team created between them is a **stale**
   * lookup and says so, rather than rendering a blank label or throwing the
   * chart away. See {@link ServiceTeamLabel}.
   */
  const teamLabelOf = useCallback(
    (serviceTeamId: string | null): ServiceTeamLabel => {
      if (serviceTeamId === null) return { state: 'none' };
      const named = teamsById.get(serviceTeamId);
      return named === undefined ? { state: 'unresolved' } : { state: 'named', name: named.name };
    },
    [teamsById],
  );

  /**
   * Which team's work each row is, the leaf's own label or the nearest
   * ancestor's — `libs/domain`'s reading, not a second copy of it.
   *
   * The rule be-01's scheduler pools on: a leaf whose own set is empty draws
   * its slots from the team an ancestor named, so a bar can be held by a pool
   * the row it sits on never mentions. Five surfaces read this one function —
   * the scheduler's adapter, this table's Team cell, the chart, the cards and
   * the export — because five copies of "most specific wins" is five chances
   * for two of them to disagree about the same row while each holds a
   * defensible answer.
   *
   * Over `flat` and not `shownRows`: an ancestor a search or a collapse has
   * taken off screen still labels the work under it.
   *
   * Memoised on the tree since R10: it is one of the seven facts the filter
   * narrows on, so a fresh `Map` on every render would rebuild the narrowed
   * tree on every keystroke in any cell of the table, not only on a change to
   * the filter.
   */
  const effectiveTeams = useMemo(() => effectiveTeamsOf(flat), [flat]);

  /**
   * The other dimension's reading, computed the same way and over the same
   * rows — one walk each, memoised, never a second copy per surface.
   */
  const effectiveTags = useMemo(() => effectiveTagsOf(flat), [flat]);

  /**
   * The third dimension's reading — one walk, memoised, over the same rows, and
   * handed the rows themselves since task 10.2.
   *
   * The `.map` that stood here folded the row's nullable column into a set of
   * nought or one, and it was the line this task named as the one to delete:
   * `WorkItemView` carries `serviceIds` now, so a row delivering two services
   * arrives as two and the walk sees what the store holds. Nothing converts at
   * this edge any more, which is why there is no third `useMemo` shape here —
   * the three dimensions read identically.
   */
  const effectiveServices = useMemo(() => effectiveServicesOf(flat), [flat]);

  /**
   * Which services each team is responsible for, from the directory's ownership
   * map — the shape `builtByNonOwner` asks for, built once instead of per row.
   *
   * A team absent from this map owns nothing, which is the map's own rule: the
   * directory ships with no ownership filled in, and every team is absent until
   * somebody says otherwise.
   *
   * **The one place `TeamView.serviceIds` may be `undefined`.** A be-01 that has
   * never heard of services sends teams without the field, which is a real
   * state for the length of a blue/green deploy; folded to `[]` here so no
   * reader below has to hold the distinction, exactly as `toTree` folds
   * `WorkItemView.serviceIds`. Everything downstream reads a list.
   */
  const ownedServicesByTeam = useMemo(
    () => new Map(teams.map((team) => [team.id, team.serviceIds ?? []])),
    [teams],
  );

  /**
   * Which teams each person belongs to — the directory's existing `person_team`
   * membership, read and never written.
   *
   * The **directory's** `people` and not `chartRead.people`, which is the one
   * place this signal may not follow the facets beside it: `AssignedPersonView`
   * is an id and a name, and only `PersonView` carries the membership. Sourced
   * from the plan's assigned people instead, every assignee would belong to no
   * team and every labelled row would wear the marker.
   *
   * Somebody the directory read has not caught up with is absent, and absent is
   * "belongs to no team" — which flags them. That is the honest answer while the
   * directory says nothing about them, and it is the same reading
   * `ownedServicesByTeam` takes above.
   */
  const teamsByPerson = useMemo(
    () => new Map(people.map((person) => [person.id, person.teamIds])),
    [people],
  );

  /**
   * Whether the directory has been told **anything** about who owns what, and
   * about who belongs where — one bit each, off the two maps above.
   *
   * These decide whether the mismatch facets can be asked at all, and the
   * reason is the opposite of the one it looks like. An empty map does not make
   * a signal quiet: `builtByNonOwner` asks whether one of the row's teams owns
   * the service, so with nobody owning anything **every** row carrying both
   * labels is flagged, and the same holds for membership. Watched, chunk 9 —
   * emptying the map under a ticked facet leaves four of six rows on screen,
   * not none. So the box is stood down not to hide a false negative but to
   * refuse a question whose only honest answer is "nobody has said who owns
   * what" — see {@link FilterFacets} for what the panel does with that.
   *
   * `some` over a non-empty list and not `size > 0`: every team is in
   * `ownedServicesByTeam` and every person in `teamsByPerson`, each with a
   * possibly-empty list, so the map having entries says only that the directory
   * has teams.
   */
  const ownershipKnown = useMemo(
    () => [...ownedServicesByTeam.values()].some((owned) => owned.length > 0),
    [ownedServicesByTeam],
  );

  const membershipKnown = useMemo(
    () => [...teamsByPerson.values()].some((memberOf) => memberOf.length > 0),
    [teamsByPerson],
  );

  /**
   * **Which** services and **which** people each row's two signals are about —
   * not merely whether they fire.
   *
   * One memo, read by the filter facets *and* by the two markers, because the
   * facets' own note says it: recomputing a signal per surface is how a filter
   * and the marker beside it start to answer two different questions about one
   * row. The booleans in {@link narrowable} are now `length > 0` over these
   * lists rather than a second call, so a row that is filtered as a non-owner
   * build is the same row that wears the mark, by construction.
   *
   * Both lists come from `label-mismatch.ts` over **one-element sets**, which
   * is the trick both its functions document rather than a fourth rule: asking
   * "is this row built by a non-owner, considering only this one service"
   * answers "is this the offending service", and the same for one assignee.
   * That is why 7.2 needed no third export — a function answering *who* would
   * be a second place for the rule to drift from.
   */
  const mismatchByRow = useMemo(() => {
    const found = new Map<string, { unownedServices: string[]; outsideAssignees: string[] }>();
    for (const row of flat) {
      const teamIds = effectiveTeams.get(row.id)?.teamIds ?? [];
      const serviceIds = effectiveServices.get(row.id)?.serviceIds ?? [];
      found.set(row.id, {
        unownedServices: serviceIds.filter((serviceId) =>
          builtByNonOwner({ serviceIds: [serviceId], teamIds, ownedServicesByTeam }),
        ),
        outsideAssignees: assigneesOf(row).filter((personId) =>
          assignedOutsideTeam({ assigneeIds: [personId], teamIds, teamsByPerson }),
        ),
      });
    }
    return found;
  }, [flat, effectiveTeams, effectiveServices, ownedServicesByTeam, teamsByPerson]);

  /**
   * A row's team as a cell or a bar can state it: its own label, or the one it
   * inherits and the row that carries it.
   *
   * The inheriting arm is what makes a moved date explicable. Without it a leaf
   * with no team of its own is `none` everywhere on screen while its dates come
   * out of a pool, and "why did this row move when somebody edited a team's
   * number" has no answer anywhere in the tool.
   */
  const effectiveTeamLabelOf = useCallback(
    (row: TreeRow): ServiceTeamLabel => {
      // The row's own set first, and `at(0)` because a set of more than one is
      // unwritable until R2-4 — R2-3 is the change that gives every member a
      // chip. Empty is *unstated* and inherits, which is the whole of the rule
      // this cell shares with the scheduler.
      const own = row.teamIds.at(0);
      if (own !== undefined) return teamLabelOf(own);
      const inherited = effectiveTeams.get(row.id);
      if (inherited === undefined) return { state: 'none' };
      const first = inherited.teamIds.at(0);
      const named = first === undefined ? undefined : teamsById.get(first);
      if (named === undefined) return { state: 'unresolved' };
      return {
        state: 'inherited',
        name: named.name,
        fromRow: namedInTheTree.get(inherited.fromId) ?? 'a row that is not shown',
      };
    },
    [teamLabelOf, effectiveTeams, teamsById, namedInTheTree],
  );

  /**
   * A row's tags as a cell or a card can state them: what it says itself, and
   * what it carries from above with the row that said each one.
   *
   * **Two lists rather than {@link effectiveTeamLabelOf}'s three states**, since
   * ADR 0008: tags accumulate, so `named` and `inherited` stopped being
   * exclusive and a row answers both at once. The split is decided on
   * `fromId === row.id` and nowhere else — the domain walk already settled which
   * row states each tag, and a second reading of `row.tagIds` here would be a
   * second answer to a question that has one.
   *
   * A name the directory read has not caught up with is simply left out — see
   * {@link TagLabel} for why there is no `unresolved` arm.
   */
  const effectiveTagLabelOf = useCallback(
    (row: TreeRow): TagLabel => {
      const own: string[] = [];
      const inherited: InheritedTagLabel[] = [];
      for (const each of effectiveTags.get(row.id) ?? []) {
        const found = tagsById.get(each.tagId);
        if (found === undefined) continue;
        if (each.fromId === row.id) own.push(found.name);
        else
          inherited.push({
            id: found.id,
            name: found.name,
            fromRow: namedInTheTree.get(each.fromId) ?? 'a row that is not shown',
          });
      }
      return { own, inherited };
    },
    [effectiveTags, tagsById, namedInTheTree],
  );

  /**
   * A row's service as a cell or a card can state it: its own, or the one it
   * inherits and the row that carries it.
   *
   * {@link effectiveTeamLabelOf}'s shape, third dimension over, and off
   * `effectiveServices` — `libs/domain`'s walk — rather than a second reading
   * of the tree.
   *
   * **The whole set since task 10.4**, where 7.1 read the first of them and said
   * so. The store became a join table in 10.2 and this was the last surface
   * still narrowing it — a two-service row read as its first service here while
   * the filter facet, `builtByNonOwner` and the export all had both. It is now
   * `effectiveTagLabelOf` with different names, which is what the domain walk
   * underneath has been since chunk 12.
   */
  const effectiveServiceLabelOf = useCallback(
    (row: TreeRow): ServiceLabel => {
      // Unnamed ids are dropped rather than carried, which is `effectiveTagLabelOf`'s
      // rule and the reason `ServiceLabel` lost its `unresolved` arm: this function
      // feeds the *placeholder*, and the chips beside it show every stated id with
      // the id itself as the fallback. A service the directory has not caught up
      // with is therefore on screen in the cell, not silently absent from it.
      const namesFor = (ids: readonly string[]): string[] =>
        ids.flatMap((id) => {
          const found = servicesById.get(id);
          return found === undefined ? [] : [found.name];
        });
      // Its own set, which is what makes the row's answer its own rather than an
      // inherited one — the emptiness below is `effectiveServicesOf`'s question,
      // not this one's.
      if (row.serviceIds.length > 0) {
        const names = namesFor(row.serviceIds);
        return names.length === 0 ? { state: 'none' } : { state: 'named', names };
      }
      const inherited = effectiveServices.get(row.id);
      if (inherited === undefined) return { state: 'none' };
      const names = namesFor(inherited.serviceIds);
      if (names.length === 0) return { state: 'none' };
      return {
        state: 'inherited',
        names,
        fromRow: namedInTheTree.get(inherited.fromId) ?? 'a row that is not shown',
      };
    },
    [servicesById, effectiveServices, namedInTheTree],
  );
  return {
    namedInTheTree,
    effectiveTeams,
    effectiveTags,
    effectiveServices,
    ownedServicesByTeam,
    teamsByPerson,
    ownershipKnown,
    membershipKnown,
    mismatchByRow,
    effectiveTeamLabelOf,
    effectiveTagLabelOf,
    effectiveServiceLabelOf,
  };
}

/**
 * Writing a row's label sets, and creating a label that does not exist yet from
 * inside the picker.
 *
 * `{ replace, create }` per vocabulary, because those are the two things a
 * reference cell does and they refuse differently — a replace can lose a race,
 * a create can collide on a name.
 */
export function useReferenceSets({
  run,
  api,
  projectId,
}: {
  run: (action: () => Promise<void>) => Promise<CommitOutcome>;
  api: ProjectApi;
  projectId: string;
}) {
  /** Replaces a work item's own team set, whole. */
  const setTeamOf = useCallback(
    (id: string, teamIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patchWorkItem(id, { teamIds: [...teamIds] })),
    [api, run],
  );

  /**
   * States which services a work item is delivered by, **whole**.
   *
   * `setTagsOf`'s shape and now its signature too: the patch states the set as
   * it will stand, so adding one sends the old set plus it, removing one sends
   * the old set minus it, and clearing sends `[]` rather than omitting the field
   * — an omitted field is "no opinion" to the patch and would leave the old
   * services standing. be-01 refuses an id the directory does not carry with
   * `unknown_service` (section 3), which is why nothing here validates a second
   * time.
   *
   * Task 10.4 took the `string | null` this had until the cell became a
   * multi-select. That parameter was the *cell's* shape rather than the
   * dimension's, and it silently dropped every service past the first on any row
   * that carried two.
   */
  const setServicesOf = useCallback(
    (id: string, serviceIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patchWorkItem(id, { serviceIds: [...serviceIds] })),
    [api, run],
  );

  /**
   * Sets a work item's tags, **whole**.
   *
   * The patch states the set as it will stand, so adding one sends the old set
   * plus it and removing one sends the old set minus it. That is not a detail
   * of this function — it is what makes the undo journal able to carry a
   * before-value, and be-01 refuses to guess at a delta.
   */
  const setTagsOf = useCallback(
    (id: string, tagIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patchWorkItem(id, { tagIds: [...tagIds] })),
    [api, run],
  );

  /** Adds a team nobody had yet and appends it to the work item's whole set. */
  const createTeamFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        // be-01 is idempotent by name, so two browsers typing `Platform` at
        // once end up on one team rather than two.
        const team = await api.addTeam(name);
        await api.patchWorkItem(id, { teamIds: [...current, team.id] });
      }),
    [api, run],
  );

  /** Adds a service nobody had yet and labels the work item with it, in one go. */
  const createServiceFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        const service = await api.addService(name);
        await api.patchWorkItem(id, { serviceIds: [...current, service.id] });
      }),
    [api, run],
  );

  /**
   * States where a work item's work also exists, **whole**.
   *
   * `setTagsOf`'s shape, with the one difference the dimension forces: the
   * members are records, so the list is sent in order and two refs into one
   * system are two entries rather than one id stated twice. `[]` takes every
   * link off and is the only spelling of that; the field is never omitted by a
   * caller that means "no links", because an omitted field is "no opinion" to
   * the patch and would leave the old list standing.
   *
   * be-01 refuses a `systemId` its directory does not hold with
   * `unknown_system`, inside its own write transaction, which is why nothing
   * here validates a second time.
   */
  const setExternalRefsOf = useCallback(
    (id: string, refs: readonly ExternalRefDraft[]): Promise<CommitOutcome> =>
      run(() => api.patchWorkItem(id, { externalRefs: refs.map((ref) => ({ ...ref })) })),
    [api, run],
  );

  /** The whole type set, replaced — `setTagsOf`'s shape and signature. */
  const setTypesOf = useCallback(
    (id: string, typeIds: readonly string[]): Promise<CommitOutcome> =>
      run(() => api.patchWorkItem(id, { typeIds: [...typeIds] })),
    [api, run],
  );

  /**
   * Adds a type nobody had yet and labels the work item with it, in one go —
   * `createTagFor`'s shape.
   *
   * This is the **only** way a type vocabulary ever gets a first member: unlike a
   * tag, which the directory page can create before any column shows it, a type's
   * column is hidden by default and its cell is where naming happens.
   */
  const createTypeFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        // be-01 is idempotent by name, so two browsers typing `Bug` at once end
        // up on one type rather than two.
        const workItemType = await api.addWorkItemType(name);
        await api.patchWorkItem(id, { typeIds: [...current, workItemType.id] });
      }),
    [api, run],
  );

  /** Adds a tag nobody had yet and labels the work item with it, in one go. */
  const createTagFor = useCallback(
    (id: string, name: string, current: readonly string[]): Promise<CommitOutcome> =>
      run(async () => {
        const tag = await api.addTag(name);
        await api.patchWorkItem(id, { tagIds: [...current, tag.id] });
      }),
    [api, run],
  );

  const assignTo = useCallback(
    (id: string, stepId: string, personId: string | null) => {
      void run(() => api.assignPerson(id, stepId, personId));
    },
    [api, run],
  );

  /**
   * Adds a person and assigns them, joining them to the work item's team.
   *
   * A person typed in against a work item labelled `Billing` almost certainly
   * belongs to Billing, and saying so beats leaving every new person a free
   * agent for somebody to sort out later. Typed in against an unlabelled work
   * item, they are a free agent — which is the absence of a team rather than
   * membership of one.
   */
  const createPersonFor = useCallback(
    (row: TreeRow, stepId: string, name: string) => {
      void run(async () => {
        const person = await api.addPerson(name, row.teamIds);
        await api.assignPerson(row.id, stepId, person.id);
      });
    },
    [api, run],
  );

  /** Changes how the project turns its trios into one number, for everybody. */
  const chooseEstimateMethod = useCallback(
    (method: EstimateMethod) => {
      void run(() => api.setEstimateMethod(projectId, method));
    },
    [api, projectId, run],
  );
  return {
    setTeamOf,
    setServicesOf,
    setTagsOf,
    createTeamFor,
    createServiceFor,
    setExternalRefsOf,
    setTypesOf,
    createTypeFor,
    createTagFor,
    assignTo,
    createPersonFor,
    chooseEstimateMethod,
  };
}

/**
 * Who does which step of which row, and the `@` that mints a person while
 * assigning them.
 *
 * Its own hook beside the label sets because an assignment names a **step** as
 * well as a row, which is the one reference in the table with two halves.
 */
export function usePlanAssignments({
  effectiveTeams,
  teams,
  mismatchByRow,
  services,
  people,
  flat,
}: {
  effectiveTeams: Map<string, EffectiveTeams>;
  teams: TeamView[];
  mismatchByRow: Map<string, { unownedServices: string[]; outsideAssignees: string[] }>;
  services: ServiceView[];
  people: PersonView[];
  flat: TreeRow[];
}) {
  /**
   * The three vocabularies these two markers read, as lookups.
   *
   * Its own copies rather than the ones {@link useReferenceSets} holds: this is
   * a separate hook with its own arguments, and threading three maps through the
   * call site to save three `Map` builds per directory read would be paying for
   * the coupling twice.
   */
  const teamsById = useMemo(() => indexById(teams), [teams]);
  const servicesById = useMemo(() => indexById(services), [services]);
  const peopleById = useMemo(() => indexById(people), [people]);

  /**
   * The teams in force for a row, as a sentence names them — the directory's
   * word where it has one, the id where it does not.
   *
   * Both markers need this half, which is why it is not written twice: the
   * non-owner sentence names who does not own the service and the assignee
   * sentence names who the person is not in, and they are the same set.
   */
  const teamNamesOn = useCallback(
    (row: TreeRow): string[] =>
      (effectiveTeams.get(row.id)?.teamIds ?? []).map((id) => teamsById.get(id)?.name ?? id),
    [effectiveTeams, teamsById],
  );

  /**
   * Why this row's service cell is marked, or `null` where it is not (task 7.2).
   *
   * Reads {@link mismatchByRow} rather than asking the domain again, so the
   * sentence names exactly the services the facet counted. **Every** offending
   * service, not the first — the scope change made the dimension a set, and a
   * marker naming one of two would send a reader to fix half of what it saw.
   *
   * A service the directory has not caught up with prints as its id, the same
   * fallback the chips beside it take: a sentence that silently dropped it
   * would name fewer services than the mark is about.
   */
  const nonOwnerNoteOf = useCallback(
    (row: TreeRow): string | null => {
      const unowned = mismatchByRow.get(row.id)?.unownedServices ?? [];
      if (unowned.length === 0) return null;
      const named = listed(unowned.map((id) => servicesById.get(id)?.name ?? id));
      const owners = teamNamesOn(row);
      return `Built by a non-owner: ${listed(owners)} ${
        owners.length === 1 ? 'does' : 'do'
      } not own ${named}.${MISMATCH_TAIL}`;
    },
    [mismatchByRow, servicesById, teamNamesOn],
  );

  /**
   * Who is doing one step of one work item, and whether anybody said so.
   *
   * The assumption — nobody named on this step and exactly one person named on
   * another, so they are taken to be doing all of it — is be-01's
   * (`doesEveryStep`), and this is the one place either renderer reads it.
   * `(unknown)` rather than nothing for a person the directory has not got:
   * somebody is assigned, and printing an empty cell would say nobody is.
   *
   * **`outside` is task 7.2's other marker**, and it rides here because this is
   * the one function every surface asks who is doing the work: the folded cell,
   * the unfolded assignee column and the plan cards all read it, so a signal
   * added here cannot be on one of them and missing from another. The person
   * shown and not the row's whole set — the assumed assignee included, because
   * a step the plan says they are doing is work assigned to them.
   */
  const assigneeOn = useCallback(
    (row: TreeRow, stepId: string): CardAssignee | null => {
      const named = row.assignees[stepId];
      const shows = named ?? row.doesEveryStep;
      if (shows === null) return null;
      const name = peopleById.get(shows)?.name ?? '(unknown)';
      // The row's own answer, filtered to the person this cell shows — and that
      // covers the assumed assignee too, which is not obvious and is the reason
      // this is written down. An assumption is `assumedAssignee(row.assignees)`
      // (`apps/be-01/src/service/assumed-assignee.ts`): the one person the row
      // *does* state, promoted to cover the steps it does not. So whoever this
      // cell shows is always in `assigneesOf(row)` and therefore always in
      // `mismatchByRow`'s list, and a second call for the assumed case cannot
      // answer anything different.
      //
      // There was one here, with a paragraph explaining why the assumed person
      // was missing from the list. F4 of chunk 17's injection round disproved
      // it: with that arm forced off, the case written for it stayed green,
      // 1565/0 — because the else branch had been answering it all along. The
      // case is kept (an assumed step must wear the mark, and nothing else
      // asserts it); the branch is gone.
      const outsider = mismatchByRow.get(row.id)?.outsideAssignees.includes(shows) ?? false;
      const teamNames = teamNamesOn(row);
      return {
        name,
        assumed: named === undefined,
        outside: outsider
          ? `Assigned outside the team: ${name} is not in ${listed(teamNames)}.${MISMATCH_TAIL}`
          : null,
      };
    },
    [peopleById, mismatchByRow, teamNamesOn],
  );

  /**
   * Whether any row on the plan names somebody for this step.
   *
   * What {@link ASSIGNEE_SLOT_PX} is spent on, and the only thing it is spent
   * on: a column nobody is assigned in reserves nothing, so an unstaffed plan
   * keeps its trio boxes at full width. Dany's own rule, 2026-08-31 — "if there
   * is no assignees on any work item, then everything is aligned vertically
   * without assignee, if there is at least one assignee, then every row moves".
   *
   * `doesEveryStep` counts, because an assumed assignee draws in the cell
   * exactly as a named one does ({@link assigneeOn} promotes it), and a slot
   * sized without it would be one the drawn initials overflow.
   *
   * Read over `flat` — every row the table is drawing — so a filter that hides
   * the only assigned row takes the slot with it, and the figures stay lined up
   * against what is actually on screen.
   */
  const assigned = useMemo(() => assignedSteps(flat), [flat]);
  const anyAssigneeOn = useCallback(
    (stepId: string): boolean => assigned.everyStep || assigned.named.has(stepId),
    [assigned],
  );
  return { nonOwnerNoteOf, assigneeOn, anyAssigneeOn };
}
