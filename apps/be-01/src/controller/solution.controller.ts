import { Elysia } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import type { AuthService } from '../service/auth.service';
import type { ProjectService } from '../service/project.service';

/** Resolves the WBS plan owned by an external solution integration. */
export function solutionController(auth: AuthService, projects: ProjectService) {
  return new Elysia().get('/plans/by-solution/:slug', async ({ params, headers, set }) => {
    const identity = await userFromHeaders(auth, headers);
    if (identity === null) {
      set.status = 401;
      return { error: 'unauthenticated' };
    }
    if (!identity.scopes.includes('read')) {
      set.status = 403;
      return { error: 'insufficient_scope' };
    }
    const found = await projects.readBySolutionSlug(params.slug);
    if (found === null) {
      set.status = 404;
      return { error: 'not_found' };
    }
    return found;
  });
}
