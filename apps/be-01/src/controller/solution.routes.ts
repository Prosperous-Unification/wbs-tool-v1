import { readSolution } from '@wbs/contracts';

import { bind } from '../http/endpoint';
import type { ProjectService } from '../service/project.service';

/**
 * Resolves the plan owned by an external solution. The mounted declaration
 * enforces read scope; an absent solution is modeled, while store failures
 * propagate without being disguised as absence.
 * Proof: replacing the slug with empty text or removing this binding each
 * returned404 instead of200 in the mounted slug-resolution case. Catching the
 * store exception as null returned404 instead of500 in the solution-settings
 * case (project.controller.test.ts).
 */
export function solutionRoutes(projects: ProjectService) {
  return [
    bind(readSolution, async ({ params }) => {
      const found = await projects.readBySolutionSlug(params.slug);
      return found === null
        ? { ok: false, status: 404, body: { error: 'not_found' } }
        : { ok: true, status: 200, body: found };
    }),
  ] as const;
}
