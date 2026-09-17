import { importProject } from '@wbs/contracts';

import type { ImportOutcome, ImportService } from '../service/import.service';
import { classifyPlanDocument } from '../service/plan-document';
import { bind, type HttpReply, type RequestFailure } from './endpoint';

type PlanImporter = Pick<ImportService, 'import'>;
type ImportReply = HttpReply<typeof importProject>;
type ImportRefusalReply = Extract<ImportReply, { ok: false }>;

function refusal(outcome: Extract<ImportOutcome, { ok: false }>): ImportRefusalReply {
  if (outcome.code === 'engine_unavailable' || outcome.code === 'source_refused') {
    return {
      ok: false,
      status: 409,
      body: { error: outcome.code, path: outcome.path, detail: outcome.detail },
    };
  }
  return {
    ok: false,
    status: 400,
    body: { error: outcome.code, path: outcome.path, detail: outcome.detail },
  };
}

async function classifyFailure(failure: RequestFailure): Promise<ImportRefusalReply> {
  if (failure.part !== 'body') {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_body', path: failure.part, detail: null },
    };
  }
  const classified = await classifyPlanDocument(failure.rejected);
  return classified.ok
    ? { ok: false, status: 400, body: { error: 'invalid_body', path: '', detail: null } }
    : {
        ok: false,
        status: 400,
        body: { error: classified.code, path: classified.path, detail: null },
      };
}

/** Binds the archival request classifier to the atomic import service. */
export function importRoutes(imports: PlanImporter) {
  return [
    bind(
      importProject,
      async ({ body, principal }): Promise<HttpReply<typeof importProject>> => {
        const classified = await classifyPlanDocument(body);
        if (!classified.ok)
          return {
            ok: false,
            status: 400,
            body: { error: classified.code, path: classified.path, detail: null },
          };
        const outcome = await imports.import(classified.value, principal.id);
        if (!outcome.ok) return refusal(outcome);
        return {
          ok: true,
          status: 201,
          body: {
            projectId: outcome.projectId,
            rows: outcome.rows,
            created: outcome.created,
            solutionRef: outcome.solutionRef,
          },
        };
      },
      { classifyRequestFailure: classifyFailure },
    ),
  ] as const;
}
