import { ESTIMATE_METHODS } from '@wbs/domain';
import { Elysia, t } from 'elysia';

import { userFromHeaders } from '../middleware/authenticated';
import type { Project } from '../repository';
import type { AuthService } from '../service/auth.service';
import type { ProjectService } from '../service/project.service';
import type { WorkItemService } from '../service/work-item.service';

/** Types only, for the same reason as authController: rules live in the service. */
const newProject = t.Object({ name: t.String() });
const projectPatch = t.Object({
  name: t.Optional(t.String()),
  restricted: t.Optional(t.Boolean()),
  // The union rather than a bare string: an unknown method reaching the column
  // would be read back as malformed data and throw on every later read of the
  // project. Refusing it here is a 422 on one request instead.
  estimateMethod: t.Optional(t.Union(ESTIMATE_METHODS.map((method) => t.Literal(method)))),
  // A day, or null to take the plan back off the calendar. The pattern is the
  // shape only; `ProjectService.update` refuses a shape-valid non-day like
  // `2026-02-31`, which is a date this schema cannot express.
  startDate: t.Optional(t.Union([t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), t.Null()])),
  solutionRef: t.Optional(
    t.Union([
      t.Object({ slug: t.String({ minLength: 1 }), url: t.String({ minLength: 1 }) }),
      t.Null(),
    ]),
  ),
});

interface ExportedWorkItem {
  number: string;
  name: string;
  dates: { startsOn: string; endsOn: string } | null;
  schedule: { duration: number; critical: boolean };
}

const markdownCell = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');

/** The human-readable projection of the same tree payload returned by JSON. */
export function projectMarkdown(project: Project, workItems: readonly ExportedWorkItem[]): string {
  const title = project.name.replaceAll(/\r?\n/g, ' ').trim();
  const rows = workItems.map((item) =>
    [
      item.number,
      item.name,
      item.dates?.startsOn ?? '—',
      item.dates?.endsOn ?? '—',
      String(item.schedule.duration),
      item.schedule.critical ? 'yes' : 'no',
    ]
      .map(markdownCell)
      .join(' | '),
  );
  return [
    `# ${title}`,
    '',
    '| WBS | Work item | Start | Finish | Duration | Critical |',
    '| --- | --- | --- | --- | ---: | :---: |',
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n');
}

/**
 * Reading is open to every authenticated account and writing is not, so
 * authentication is checked on every route and *authorisation* only on the ones
 * that write. `ProjectService.update` owns that second check — the controller
 * translates its refusal into a status rather than deciding anything itself,
 * which keeps one copy of the rule for the mutations still to come.
 */
export function projectController(
  auth: AuthService,
  projects: ProjectService,
  workItems: WorkItemService,
) {
  return new Elysia({ prefix: '/api/projects' })
    .post(
      '/',
      async ({ body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        return projects.create(body.name, user.id);
      },
      { body: newProject },
    )
    .get('/', async ({ headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return { projects: await projects.list(user.id) };
    })
    .post('/:id/opened', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      // No authorisation check beyond authentication: this is the caller's own
      // navigation history, and every account may already read every project.
      // See `ProjectService.open`.
      const recorded = await projects.open(params.id, user.id);
      if (!recorded) {
        set.status = 404;
        return { error: 'not_found' };
      }
      set.status = 204;
      return null;
    })
    .get('/:id/export', async ({ params, query, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      if (!user.scopes.includes('read')) {
        set.status = 403;
        return { error: 'insufficient_scope' };
      }
      const format = query['format'];
      if (format !== 'json' && format !== 'markdown') {
        set.status = 400;
        return { error: 'unsupported_format' };
      }
      const found = await projects.read(params.id);
      if (found === null) {
        set.status = 404;
        return { error: 'not_found' };
      }
      const tree = await workItems.tree(params.id);
      if (tree === null) {
        set.status = 404;
        return { error: 'not_found' };
      }
      if (format === 'markdown') {
        set.headers['content-type'] = 'text/markdown; charset=utf-8';
        return projectMarkdown(found.project, tree.workItems);
      }
      set.headers['content-type'] = 'application/json; charset=utf-8';
      return { project: found.project, ...tree };
    })
    .get('/:id', async ({ params, headers, set }) => {
      const user = await userFromHeaders(auth, headers);
      if (user === null) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const found = await projects.read(params.id);
      if (found === null) {
        set.status = 404;
        return { error: 'not_found' };
      }
      return found;
    })
    .patch(
      '/:id',
      async ({ params, body, headers, set }) => {
        const user = await userFromHeaders(auth, headers);
        if (user === null) {
          set.status = 401;
          return { error: 'unauthenticated' };
        }
        const outcome = await projects.update(params.id, user.id, body);
        if (!outcome.ok) {
          // 403 rather than 404 for a restricted project: the caller may read
          // it, so pretending it is absent would contradict the next GET. A
          // date that is not a day is the caller's mistake, not a missing row.
          set.status =
            outcome.reason === 'forbidden' ? 403 : outcome.reason === 'bad_start_date' ? 422 : 404;
          return { error: outcome.reason };
        }
        return { project: outcome.result };
      },
      { body: projectPatch },
    );
}
