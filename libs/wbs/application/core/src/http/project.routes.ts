import {
  createProject,
  exportProject,
  listProjects,
  patchProject,
  readProject,
  recordProjectOpen,
  retryProjectOptimization,
} from '@wbs/contracts';
import type { SolverObjectiveName } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

import type { Project } from '../ports/project-store';
import type { OptimizationVariantState } from '../ports/scheduler';
import { canEdit, type ProjectService } from '../service/project.service';
import type { WorkItemService } from '../service/work-item.service';
import { bind, EMPTY, type HttpReply, type RequestFailure } from './endpoint';

export interface OptimizationRetry {
  retry(ask: {
    readonly projectId: string;
    readonly objective: SolverObjectiveName;
    readonly inputHash: string;
    readonly input: ScheduleInput;
  }):
    | { readonly kind: 'stale-input-hash'; readonly currentInputHash: string }
    | { readonly kind: 'not-retryable'; readonly state: OptimizationVariantState['state'] }
    | { readonly kind: 'already-running' }
    | {
        readonly kind: 'accepted';
        readonly state: 'retrying';
        readonly generation: number;
        readonly inputHash: string;
      };
}

interface ExportedWorkItem {
  number: string;
  name: string;
  dates: { startsOn: string; endsOn: string } | null;
  schedule: { duration: number; critical: boolean };
}

// Proof: bypassing escaping made the mounted Markdown export contain Build | ship
// instead of the escaped Build \| ship cell.
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

/** Structural bodies retain 422; malformed JSON and other request parts use 400.
 * Proof: returning 400 for invalid_body made the mounted undeclared-create test receive 500 instead of 422. */
function classifyBodyFailure(failure: RequestFailure) {
  switch (failure.code) {
    case 'invalid_body':
      return { ok: false, status: 422, body: { error: 'invalid_body' } } as const;
    case 'invalid_json':
      return { ok: false, status: 400, body: { error: 'invalid_json' } } as const;
    case 'invalid_params':
      return { ok: false, status: 400, body: { error: 'invalid_params' } } as const;
    case 'invalid_query':
      return { ok: false, status: 400, body: { error: 'invalid_query' } } as const;
  }
}

/** Invalid format wins over query extras, matching the legacy format check before any read.
 * Proof: omitting this classifier changed the mounted export-format test from unsupported_format to invalid_query. */
function classifyExportFailure(failure: RequestFailure) {
  if (failure.part === 'query') {
    const format = failure.request.url.searchParams.getAll('format').at(-1);
    return format !== 'json' && format !== 'markdown'
      ? ({ ok: false, status: 400, body: { error: 'unsupported_format' } } as const)
      : ({ ok: false, status: 400, body: { error: 'invalid_query' } } as const);
  }
  return failure.part === 'params'
    ? ({ ok: false, status: 400, body: { error: 'invalid_params' } } as const)
    : ({ ok: false, status: 400, body: { error: 'invalid_body' } } as const);
}

/**
 * Project operations share wire declarations; ProjectService retains ownership
 * of access checks, semantic date/weight refusals and optimizer announcements.
 * Opening is caller navigation, so it bypasses canEdit while retaining write scope.
 */
export function projectRoutes(
  projects: ProjectService,
  workItems: WorkItemService,
  optimizer?: OptimizationRetry,
) {
  return [
    bind(
      createProject,
      async ({ body, principal }) => ({
        ok: true,
        status: 200,
        body: await projects.create(body.name, principal.id),
      }),
      { classifyRequestFailure: classifyBodyFailure },
    ),
    bind(listProjects, async ({ principal }) => ({
      ok: true,
      status: 200,
      body: { projects: await projects.list(principal.id) },
    })),
    // Proof: returning null instead of EMPTY made the mounted reader-open test receive 500 instead of 204.
    bind(recordProjectOpen, async ({ params, principal }) =>
      (await projects.open(params.id, principal.id))
        ? { ok: true, status: 204, body: EMPTY }
        : { ok: false, status: 404, body: { error: 'not_found' } },
    ),
    bind(
      exportProject,
      async ({ params, query }): Promise<HttpReply<typeof exportProject>> => {
        const found = await projects.read(params.id);
        if (found === null) return { ok: false, status: 404, body: { error: 'not_found' } };
        const tree = await workItems.tree(params.id);
        if (tree === null) return { ok: false, status: 404, body: { error: 'not_found' } };
        // Proof: removing this branch made both mounted unavailable export cases
        // receive 500 instead of 409, before either could inspect media or body.
        if ('kind' in tree)
          return {
            ok: false,
            status: 409,
            body: { error: tree.error, engine: tree.engine },
          };
        if (query.format === 'markdown')
          return {
            ok: true,
            status: 200,
            // Proof: returning this as a JSON body made the mounted Markdown export receive 500 instead of 200.
            text: projectMarkdown(found.project, tree.workItems),
          };
        return {
          ok: true,
          status: 200,
          body: { project: found.project, ...tree },
          headers: [['content-type', 'application/json; charset=utf-8']],
        };
      },
      { classifyRequestFailure: classifyExportFailure },
    ),
    bind(readProject, async ({ params }) => {
      const found = await projects.read(params.id);
      return found === null
        ? { ok: false, status: 404, body: { error: 'not_found' } }
        : { ok: true, status: 200, body: found };
    }),
    bind(
      patchProject,
      async ({ params, body, principal }): Promise<HttpReply<typeof patchProject>> => {
        const outcome = await projects.update(params.id, principal.id, body);
        if (outcome.ok) return { ok: true, status: 200, body: { project: outcome.value } };
        switch (outcome.reason) {
          case 'not_found':
            return { ok: false, status: 404, body: { error: outcome.reason } };
          case 'forbidden':
            return { ok: false, status: 403, body: { error: outcome.reason } };
          case 'bad_start_date':
          case 'bad_pert_weights':
            return { ok: false, status: 422, body: { error: outcome.reason } };
          // Proof: mapping this to 422 made the mounted unavailable-optimizer test receive 500 instead of 409.
          case 'optimizer_unavailable':
            return { ok: false, status: 409, body: { error: outcome.reason } };
        }
      },
      { classifyRequestFailure: classifyBodyFailure },
    ),
    bind(
      retryProjectOptimization,
      async ({ params, body, principal }): Promise<HttpReply<typeof retryProjectOptimization>> => {
        const found = await projects.read(params.id);
        if (found === null) return { ok: false, status: 404, body: { error: 'not_found' } };
        if (!canEdit(found.project, principal.id)) {
          return { ok: false, status: 403, body: { error: 'forbidden' } };
        }
        const input = await workItems.scheduleInput(params.id);
        if (input === null) return { ok: false, status: 404, body: { error: 'not_found' } };
        if (optimizer === undefined) {
          return {
            ok: false,
            status: 409,
            body: { code: 'not-retryable', state: 'idle' },
          };
        }
        const outcome = optimizer.retry({ projectId: params.id, ...body, input });
        switch (outcome.kind) {
          case 'stale-input-hash':
            return {
              ok: false,
              status: 409,
              body: {
                code: 'stale-input-hash',
                currentInputHash: outcome.currentInputHash,
              },
            };
          case 'not-retryable':
            return {
              ok: false,
              status: 409,
              body: { code: 'not-retryable', state: outcome.state },
            };
          case 'already-running':
            return { ok: false, status: 409, body: { code: 'already-running' } };
          case 'accepted':
            return {
              ok: true,
              status: 202,
              body: {
                state: outcome.state,
                generation: outcome.generation,
                inputHash: outcome.inputHash,
              },
            };
        }
      },
      { classifyRequestFailure: classifyBodyFailure },
    ),
  ] as const;
}
