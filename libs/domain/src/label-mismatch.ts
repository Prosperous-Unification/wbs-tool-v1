/**
 * The two mismatch signals, one vocabulary: work **built by a non-owner** and
 * work **assigned outside the team** (design.md D5).
 *
 * Both answer the same shape of question — a row states two facts, the
 * directory says how those facts relate, and they do not relate that way. Dany,
 * 2026-08-20 23:18 and 23:19, asked for both in one breath ("Same for
 * assignees"), and they live in one module because a reader who finds one
 * should find the other beside it rather than discover months later that the
 * other exists.
 *
 * In `libs/domain` rather than in fe-01 because the rule is a domain sentence
 * and not a rendering: the day an export column or an MCP tool wants the flag,
 * be-01 needs the same function fe-01 filters with. The alternative — be-01
 * computing a boolean per row and sending it — was rejected in D4 for the
 * reason it is always rejected here: the client needs the rule anyway to
 * narrow its tree without a round trip, so a derived flag on the wire is a
 * second copy of a rule, and the copy that drifts is the one nobody reads.
 *
 * **Neither of these blocks anything.** No refusal, no confirm, no date moves.
 * Recording that a non-owner built something is the plan being honest about
 * what happened; refusing the write is how a tool gets worked around, and
 * `assignment`'s own JSDoc already says a person is deliberately unconstrained
 * by the item's team (Dany, 2026-08-06 — "keep people and service/team lists
 * decoupled"). That is why these are signals and not validations.
 */

/**
 * What a row and the directory have to say before the non-owner question can be
 * asked of them.
 */
export interface BuiltByNonOwnerAsked {
  /**
   * The services in force for this row — `effectiveServicesOf`'s answer, or
   * empty where no row above it states any.
   *
   * The **effective** reading, never `work_item.service_id` straight off the
   * row: a leaf inheriting `Payments` from its parent is delivering `Payments`,
   * and a signal reading the stored column would fall silent exactly where the
   * inheritance is doing the work.
   *
   * A set since the 2026-08-21 scope change ("can be several services"), which
   * is what makes the rule below an **any** rather than a lookup.
   */
  serviceIds: readonly string[];
  /**
   * The teams in force for this row — `effectiveTeamsOf`'s answer, or empty
   * where no row above it states one.
   *
   * The **effective** reading for `serviceId`'s reason, and this half is the
   * one with a history: `RowFacets.teamIds` names the two occasions this repo
   * shipped a stored-instead-of-effective read. Here it would be quieter than a
   * missing filter result — a leaf under a `Platform` parent, delivering a
   * service Platform does not own, would carry no marker at all.
   */
  teamIds: readonly string[];
  /**
   * Which services each team owns, from the directory's `team_service` map —
   * `TeamView.serviceIds`, keyed by team id.
   *
   * A team absent from the map owns nothing, which is the same answer as an
   * empty set and deliberately not a different one: "we have not filled the map
   * in" and "this team owns no services" are indistinguishable facts about the
   * directory, and inventing a third state would put a marker on rows nobody
   * has said anything about.
   */
  ownedServicesByTeam: ReadonlyMap<string, readonly string[]>;
}

/**
 * Whether this row's work includes a service that none of the teams doing it
 * own.
 *
 * True when **both** facts are stated and **at least one** service disagrees: a
 * service in force that no team in force owns (Dany's scope change, 2026-08-21
 * — "a row is built by a non-owner when at least one effective service is
 * missing from the team's owned set"). Everything else is false.
 *
 * **Any rather than every**, and the choice is the same one
 * {@link assignedOutsideTeam} already made one signal over: a row delivering
 * `Payments` and `Search` where the team owns only `Search` is a row where
 * somebody is building something they do not own, and a rule demanding *all*
 * of them be unowned would go quiet on exactly the mixed case worth seeing.
 * The two signals now read alike — some service unowned, some assignee outside
 * — which is the one vocabulary the module was written for.
 *
 * **Absence is not a mismatch** — no service, or no team, and the answer is
 * false. This is a rule rather than a convenient default: a marker that lands
 * on every unlabelled row would cover most of a young plan, and a marker that
 * covers most of a plan teaches its readers to stop seeing it, which is worse
 * than not having one.
 *
 * Any owner clears a service. A row labelled with two teams, one of which owns
 * the service, was built by an owner — the question is whether that service
 * sits inside somebody's ownership, not whether every team named on the row
 * owns it.
 *
 * **Which services** the marker names (task 7.2's hover sentence) is this same
 * function over a one-element set, the trick {@link assignedOutsideTeam}
 * documents and for its reason — one rule, one place to drift:
 * `serviceIds.filter((id) => builtByNonOwner({ serviceIds: [id], teamIds,
 * ownedServicesByTeam }))`.
 */
export function builtByNonOwner({
  serviceIds,
  teamIds,
  ownedServicesByTeam,
}: BuiltByNonOwnerAsked): boolean {
  // The guard splits the way `assignedOutsideTeam`'s does, now that both sides
  // are sets. The `serviceIds` half is a **statement of the rule rather than
  // load-bearing code** — `.some` over an empty set already answers false — and
  // stays so a reader meets the absence rule spelled the same way in both
  // signals. The `teamIds` half *is* load-bearing: without it every service on
  // a row nobody gave a team to reads as unowned, and the marker lands on the
  // rows least worth marking.
  if (serviceIds.length === 0 || teamIds.length === 0) return false;
  return serviceIds.some(
    (serviceId) => !teamIds.some((teamId) => ownedServicesByTeam.get(teamId)?.includes(serviceId)),
  );
}

/**
 * What a row and the directory have to say before the assignee question can be
 * asked of them.
 */
export interface AssignedOutsideTeamAsked {
  /**
   * Everybody named on any of this row's phases, deduplicated —
   * `RowFacets.assigneeIds`' grain, because the signal is shown on a row's
   * assignee cell and a row is what carries the union of its slices' answers.
   */
  assigneeIds: readonly string[];
  /** The teams in force for this row — {@link BuiltByNonOwnerAsked.teamIds}, unchanged. */
  teamIds: readonly string[];
  /**
   * Which teams each person belongs to, from the directory's existing
   * `person_team` membership — `PersonView.teamIds`, keyed by person id.
   *
   * Read, never written: this change adds no membership storage, because the
   * membership was already there (`schema.ts:865`, verified in the tree before
   * the design leaned on it). A person absent from the map belongs to no team,
   * which is what a person the directory has no membership rows for is.
   */
  teamsByPerson: ReadonlyMap<string, readonly string[]>;
}

/**
 * Whether this row names somebody who belongs to none of the teams doing the
 * work.
 *
 * True when a team is in force and **some** assignee belongs to none of those
 * teams — some rather than every, because one outsider on a row is the fact
 * worth showing, and a row where everybody is outside is not a different kind
 * of event.
 *
 * **Absence flags nothing**, the same rule as {@link builtByNonOwner}: no
 * assignee, or no team, and the answer is false.
 *
 * **Which person** the marker names (task 7.2's hover sentence) is this same
 * function over a one-element set, so the naming needs no second export and no
 * second rule: `assigneeIds.filter((id) => assignedOutsideTeam({ assigneeIds:
 * [id], teamIds, teamsByPerson }))`. A third function answering "who" would be
 * a second place for the rule to drift.
 */
export function assignedOutsideTeam({
  assigneeIds,
  teamIds,
  teamsByPerson,
}: AssignedOutsideTeamAsked): boolean {
  // The `assigneeIds` half of this guard is a **statement of the rule rather
  // than load-bearing code**: `.some` over an empty set already answers false,
  // so striking it fails nothing (watched 2026-08-21 — 114 pass, 0 fail). It
  // stays because absence is one rule across both signals and a reader should
  // meet it spelled the same way in both; this comment is what stops the next
  // reader assuming a test protects it. The `teamIds` half *is* load-bearing —
  // without it a row with no team flags every assignee on it, and striking it
  // fails the no-team case.
  if (assigneeIds.length === 0 || teamIds.length === 0) return false;
  return assigneeIds.some((personId) => {
    const belongsTo = teamsByPerson.get(personId) ?? [];
    return !belongsTo.some((teamId) => teamIds.includes(teamId));
  });
}
