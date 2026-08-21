import { Elysia, t } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';
import type {
  DirectoryRefusal,
  DirectoryService,
  RemoveDirectoryOutcome,
} from '../service/directory.service';

const named = t.Object({ name: t.String() });
const newPerson = t.Object({ name: t.String(), teamIds: t.Optional(t.Array(t.String())) });

/**
 * Both fields optional, and the service refuses the patch that names neither.
 *
 * Elysia could refuse an empty body here, but the refusal a client acts on has
 * to be the same one whether the body was `{}` or `{ name: undefined }`, and
 * only the service sees both as the same thing.
 */
const personPatch = t.Object({
  name: t.Optional(t.String()),
  teamIds: t.Optional(t.Array(t.String())),
});

/**
 * {@link personPatch}' shape one dimension over, and optional for its reason.
 *
 * `serviceIds` is the **ownership map**: a full replacement, so an absent field
 * leaves it alone and an empty array makes the team own nothing. Only the
 * service tells those two apart, which is why neither is defaulted here.
 */
const teamPatch = t.Object({
  name: t.Optional(t.String()),
  serviceIds: t.Optional(t.Array(t.String())),
});

/**
 * `taken` is 409 and a blank or absent name is 422, the same split
 * `roleController` makes: a duplicate name is a well-formed request that
 * conflicts with the directory as it stands, and a name of spaces is the
 * request itself being wrong.
 *
 * `unknown_team` joins `not_found` on 404, as `unknown_role` already does on
 * the work item routes: an id the directory no longer holds is a thing that is
 * not there, whichever of the request's ids named it. `unknown_service` is the
 * same sentence about the third dimension — an ownership map naming a service
 * nothing holds — and answers the same 404 the work item routes answer for it.
 */
const statusFor = (reason: DirectoryRefusal): number =>
  reason === 'not_found' || reason === 'unknown_team' || reason === 'unknown_service' ? 404 : 422;

/**
 * `?cascade=true` and nothing else — the same flag `roleController`'s delete
 * takes, and the second, explicit call rather than a body on a DELETE.
 */
const isCascade = (query: Record<string, string | undefined>): boolean =>
  query['cascade'] === 'true';

/**
 * How a removal answers, in one place because the two delete routes must answer
 * identically — a client that had to branch on which of a person and a team it
 * had asked about would drift.
 *
 * 409, not 400: the request is well formed and would have worked against a
 * directory nothing pointed into. The **directory usage** rides along because
 * the next request is the same one with the flag, and the person confirming has
 * to know what they are agreeing to.
 */
function answerRemoval(outcome: RemoveDirectoryOutcome, set: { status?: number | string }) {
  if (!outcome.ok) {
    if (outcome.reason === 'in_use') {
      set.status = 409;
      return { error: outcome.reason, usage: outcome.usage };
    }
    set.status = 404;
    return { error: outcome.reason };
  }
  set.status = 204;
  return null;
}

/**
 * Teams and people: global, readable and writable by any authenticated
 * account.
 *
 * Not gated by project write access, because the directory belongs to no
 * project — Dany, 2026-08-06: "the list is global for all projects, anyone can
 * add one". Gating it on a project would mean a reader who may not edit
 * project A could not name a team while working in project B.
 *
 * Adding is idempotent by name, so the picker's "type it if it is not in the
 * list" cannot make two `Platform`s.
 */
export function directoryController(auth: AuthService, directory: DirectoryService) {
  return (
    new Elysia({ prefix: '/api' })
      .get('/teams', async ({ headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return { teams: await directory.listTeams() };
      })
      .post(
        '/teams',
        async ({ body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          const team = await directory.addTeam(body.name);
          if (team === null) {
            // A team called nothing helps nobody find anything, and it would sit
            // in every picker for ever.
            set.status = 422;
            return { error: 'name_required' };
          }
          return { team };
        },
        { body: named },
      )
      .patch(
        '/teams/:id',
        async ({ params, body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          // Spread rather than passed whole, for `/people/:id`'s reason: an
          // absent `serviceIds` leaves the ownership map alone and an empty one
          // makes the team own nothing, and `{ serviceIds: undefined }` would
          // have to be told apart from the absence by every layer below.
          const outcome = await directory.patchTeam(params.id, {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.serviceIds === undefined ? {} : { serviceIds: body.serviceIds }),
          });
          if (!outcome.ok) {
            if (outcome.reason === 'taken') {
              // The surviving name rides along because the caller has to say
              // which `Platform` is on screen now, and a bare 409 cannot.
              set.status = 409;
              return { error: outcome.reason, name: outcome.name };
            }
            set.status = statusFor(outcome.reason);
            return { error: outcome.reason };
          }
          return { team: outcome.result };
        },
        { body: teamPatch },
      )
      .get('/people', async ({ headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return { people: await directory.listPeople() };
      })
      .post(
        '/people',
        async ({ body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          // No teams is a free agent, which is the absence of memberships rather
          // than membership of a magic row.
          const outcome = await directory.addPerson(body.name, body.teamIds ?? []);
          if (!outcome.ok) {
            // `taken` cannot arrive here — adding is idempotent by name — but the
            // outcome type carries it, and answering the same 409 the patch does
            // is the only honest thing to do with it.
            if (outcome.reason === 'taken') {
              set.status = 409;
              return { error: outcome.reason, name: outcome.name };
            }
            set.status = statusFor(outcome.reason);
            return { error: outcome.reason };
          }
          return { person: outcome.result };
        },
        { body: newPerson },
      )
      .patch(
        '/people/:id',
        async ({ params, body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          // Spread rather than passed whole: an absent `teamIds` leaves the
          // memberships alone and an empty one makes a free agent, and
          // `{ teamIds: undefined }` would have to be told apart from the
          // absence by every layer below.
          const outcome = await directory.patchPerson(params.id, {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.teamIds === undefined ? {} : { teamIds: body.teamIds }),
          });
          if (!outcome.ok) {
            if (outcome.reason === 'taken') {
              set.status = 409;
              return { error: outcome.reason, name: outcome.name };
            }
            set.status = statusFor(outcome.reason);
            return { error: outcome.reason };
          }
          return { person: outcome.result };
        },
        { body: personPatch },
      )
      .delete('/people/:id', async ({ params, query, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return answerRemoval(await directory.removePerson(params.id, isCascade(query)), set);
      })
      .delete('/teams/:id', async ({ params, query, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return answerRemoval(await directory.removeTeam(params.id, isCascade(query)), set);
      })
      /*
      The tag routes, and they are the team routes with the capacity taken out.
      **Global — no project in the path and none in the query**, exactly as the
      teams are: a label that meant one thing on one plan and another on the next
      would make this a per-project screen and the filter a per-project
      vocabulary.

      There is deliberately no membership route beside them. Nobody belongs to a
      tag, and the absence is the model rule rather than a gap to fill later.
    */
      .get('/tags', async ({ headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return { tags: await directory.listTags() };
      })
      .post(
        '/tags',
        async ({ body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          const tag = await directory.addTag(body.name);
          if (tag === null) {
            // A tag called nothing helps nobody find anything, and it would sit in
            // every picker for ever — `/teams`' 422, one dimension over.
            set.status = 422;
            return { error: 'name_required' };
          }
          return { tag };
        },
        { body: named },
      )
      .patch(
        '/tags/:id',
        async ({ params, body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          const outcome = await directory.renameTag(params.id, body.name);
          if (!outcome.ok) {
            if (outcome.reason === 'taken') {
              // The surviving name rides along for `/teams/:id`'s reason: the
              // caller has to say which `regulatory` is on screen now, and a bare
              // 409 cannot.
              set.status = 409;
              return { error: outcome.reason, name: outcome.name };
            }
            set.status = statusFor(outcome.reason);
            return { error: outcome.reason };
          }
          return { tag: outcome.result };
        },
        { body: named },
      )
      .delete('/tags/:id', async ({ params, query, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        // The same 409-then-`?cascade=1` shape every directory removal has. What
        // the confirmation lists is `label_removed` per work item and nothing
        // else: no capacity is released and no date moves, which is asserted in
        // `tags`' verify.md rather than claimed here.
        return answerRemoval(await directory.removeTag(params.id, isCascade(query)), set);
      })
      /*
      The service routes: the tag routes again, with the removal's effect
      spelled the other way.

      **Global, exactly as the teams and the tags are** — no project in the path
      and none in the query. A service that meant `Payments` on one plan and
      something else on the next would make this a per-project screen.

      No membership route here either, and for a different absence than the
      tag's: people belong to *teams*, and a team's **ownership** of services is
      edited on the team row rather than here (Dany, 2026-08-20: _"one team can
      be responsible for several services"_). That write is task 4.3 and it is a
      field of the team patch, not a route of its own.
    */
      .get('/services', async ({ headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return { services: await directory.listServices() };
      })
      .post(
        '/services',
        async ({ body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          const added = await directory.addService(body.name);
          if (added === null) {
            // `/tags`' 422, one dimension over: a service called nothing would
            // sit in every picker with no way to tell it from the next one.
            set.status = 422;
            return { error: 'name_required' };
          }
          return { service: added };
        },
        { body: named },
      )
      .patch(
        '/services/:id',
        async ({ params, body, headers, set }) => {
          const user = await userFromHeaders(auth, headers);
          if (user === null) {
            set.status = 401;
            return { error: 'unauthenticated' };
          }
          const outcome = await directory.renameService(params.id, body.name);
          if (!outcome.ok) {
            if (outcome.reason === 'taken') {
              // The surviving name rides along for `/teams/:id`'s reason: the
              // caller has to say which `Payments` is on screen now.
              set.status = 409;
              return { error: outcome.reason, name: outcome.name };
            }
            set.status = statusFor(outcome.reason);
            return { error: outcome.reason };
          }
          return { service: outcome.result };
        },
        { body: named },
      )
      .delete('/services/:id', async ({ params, query, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        // The same 409-then-confirm shape every directory removal has. What the
        // confirmation lists is `label_nulled` per work item and nothing else:
        // no capacity is released, because a service has no pool, and the
        // `team_service` rows the removal also takes are deliberately absent
        // from it (design.md D7).
        return answerRemoval(await directory.removeService(params.id, isCascade(query)), set);
      })
  );
}
