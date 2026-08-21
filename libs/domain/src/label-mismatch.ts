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
   * The service in force for this row — `effectiveServicesOf`'s answer, or
   * `null` where no row above it states one.
   *
   * The **effective** reading, never `work_item.service_id` straight off the
   * row: a leaf inheriting `Payments` from its parent is delivering `Payments`,
   * and a signal reading the stored column would fall silent exactly where the
   * inheritance is doing the work.
   */
  serviceId: string | null;
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
 * Whether this row's work was built by a team that does not own the service it
 * delivers.
 *
 * True only when **both** facts are stated and they disagree: a service in
 * force, at least one team in force, and not one of those teams owning that
 * service. Everything else is false.
 *
 * **Absence is not a mismatch** — no service, or no team, and the answer is
 * false. This is a rule rather than a convenient default: a marker that lands
 * on every unlabelled row would cover most of a young plan, and a marker that
 * covers most of a plan teaches its readers to stop seeing it, which is worse
 * than not having one.
 *
 * Any owner clears it. A row labelled with two teams, one of which owns the
 * service, was built by an owner — the question is whether the work sits inside
 * the ownership, not whether every team named on it owns the thing.
 */
export function builtByNonOwner({
  serviceId,
  teamIds,
  ownedServicesByTeam,
}: BuiltByNonOwnerAsked): boolean {
  if (serviceId === null || teamIds.length === 0) return false;
  return !teamIds.some((teamId) => ownedServicesByTeam.get(teamId)?.includes(serviceId));
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
  if (assigneeIds.length === 0 || teamIds.length === 0) return false;
  return assigneeIds.some((personId) => {
    const belongsTo = teamsByPerson.get(personId) ?? [];
    return !belongsTo.some((teamId) => teamIds.includes(teamId));
  });
}
