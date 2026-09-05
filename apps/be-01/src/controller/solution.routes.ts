import { callerGuard } from '../http/caller';
import { ok, respond, type Route } from '../http/route';
import type { AuthService } from '../service/auth.service';
import type { ProjectService } from '../service/project.service';

/**
 * Resolves the WBS plan owned by an external solution integration.
 *
 * `read-scope` rather than plain `signed-in`, and it is one of only two routes
 * that ask: this hands a whole plan to a machine caller by a slug it can guess
 * at, so an integration token has to have been granted `read` — see
 * {@link CallerRequirement}.
 */
export function solutionRoutes(auth: AuthService, projects: ProjectService): Route[] {
  const guard = callerGuard(auth);
  return [
    {
      method: 'GET',
      path: '/plans/by-solution/:slug',
      handler: guard('read-scope', async ({ params }) => {
        const found = await projects.readBySolutionSlug(params['slug']);
        return found === null ? respond(404, { error: 'not_found' }) : ok(found);
      }),
    },
  ];
}
