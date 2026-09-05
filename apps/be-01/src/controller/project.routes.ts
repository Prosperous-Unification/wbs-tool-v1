import { DEPENDENCY_REACHES, ESTIMATE_METHODS, ESTIMATE_ROUNDINGS } from '@wbs/domain';

import { callerGuard } from '../http/caller';
import { checkedBody } from '../http/elysia/hand-parsed-body';
import {
  isFieldBag,
  noContent,
  ok,
  respond,
  type Route,
  type RouteResponse,
  text,
} from '../http/route';
import type { Project, ProjectPatch } from '../repository';
// The two vocabularies as values, from `schema.ts` rather than from
// `../repository`, which is type-only on purpose — the same path
// `directory.service.ts` takes for `PERSON_KINDS`.
import { SCHEDULE_ENGINES, SOLVER_OBJECTIVES } from '../repository/schema';
import type { AuthService } from '../service/auth.service';
import type { ProjectService } from '../service/project.service';
import type { WorkItemService } from '../service/work-item.service';
import { statusForRefusal } from './refusal-status';

/**
 * Both bodies were TypeBox schemas Elysia validated before a handler ran, and
 * both are checked by hand here for the reason `step.routes.ts` gives at
 * length: a route module cannot declare a validator to a framework it does not
 * import.
 *
 * **The status stays 422**, which is what Elysia answered for a schema failure.
 * It is the one thing about these checks a client can observe, and moving it to
 * 400 would have been a silent API change dressed as a refactor — the more so
 * because run 2 measured that only *one* of the eleven `PATCH` fields has a
 * test asserting its refusal at all.
 *
 * **Unknown properties are dropped, not refused.** Elysia strips them before
 * the handler sees the body, so a client sending a field this API does not have
 * has always been answered 200 with that field ignored, and
 * {@link patchFrom} keeps that by building a fresh object out of the keys it
 * knows rather than by passing the body through. Refusing them instead would be
 * a new rule invented by a refactor.
 *
 * The old schemas were *functions* returning a fresh object rather than module
 * constants, because Elysia wrote `additionalProperties` into whatever schema
 * object it was handed and a shared one was mutable state across every app in
 * the process. Nothing here is handed to a framework, so that hazard is gone
 * with the framework — {@link PATCH_BODY} is a plain constant.
 */
const isOneOf = <T extends string>(vocabulary: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (vocabulary as readonly string[]).includes(value);

/** A refusal, or `undefined` where the field is absent, or the value. */
type Checked<T> = { refused: true } | { refused: false; value: T | undefined };

const refused = { refused: true } as const;
const taken = <T>(value: T | undefined): Checked<T> => ({ refused: false, value });

function checkedString(value: unknown): Checked<string> {
  if (value === undefined) return taken(undefined);
  return typeof value === 'string' ? taken(value) : refused;
}

function checkedBoolean(value: unknown): Checked<boolean> {
  if (value === undefined) return taken(undefined);
  return typeof value === 'boolean' ? taken(value) : refused;
}

function checkedFrom<T extends string>(vocabulary: readonly T[], value: unknown): Checked<T> {
  if (value === undefined) return taken(undefined);
  return isOneOf(vocabulary, value) ? taken(value) : refused;
}

/**
 * A day-shaped string or `null`, matching the pattern the schema carried.
 *
 * The shape only. `ProjectService.update` refuses a shape-valid non-day like
 * `2026-02-31`, which is a date neither this check nor the pattern it replaces
 * can express — and it answers 422 for it, the same status, so the split
 * between the two boundaries is invisible to a caller.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkedStartDate(value: unknown): Checked<string | null> {
  if (value === undefined) return taken(undefined);
  if (value === null) return taken(null);
  return typeof value === 'string' && DAY.test(value) ? taken(value) : refused;
}

/**
 * The three coefficients, together or not at all: the divisor is their sum, so
 * a request naming one of them is asking for an arithmetic it has not stated.
 *
 * `Number.isFinite` rather than `>= 0` alone, and that is the whole reason this
 * check is written out rather than trusted to a hand-rolled comparison:
 * `1e999` is the one non-finite number JSON can express, it satisfies every
 * `>= 0` ever written, and `project.service.ts` says in as many words that this
 * codebase has already paid for that once. TypeBox's `t.Number` is a finite
 * number; so is this.
 *
 * **Measured, and not what `project.service.ts` claims:** with both the finite
 * check and the `>= 0` deleted, `project.controller.test.ts` stays at 32 pass /
 * 0 fail. The service's own `PertWeights` refuses `Infinity`, a negative weight
 * and the all-zero triple alike, and answers **422** for all of them — the same
 * status this boundary answers, so no test can tell the two apart. The service
 * comment reading "both measured in `project.controller.test.ts`" is measuring
 * the outcome, not which boundary produced it. The check stays because deleting
 * a boundary rule is not a refactor's business, but nothing here is load-bearing
 * and a reader should not think it is.
 *
 * The all-zero triple is *not* refused here, deliberately: no shape rule can
 * say "not all of them", and `ProjectService.update` refuses it as 422 through
 * `PertWeights`, which is the one rule both boundaries ask.
 */
function checkedWeights(
  value: unknown,
): Checked<{ optimistic: number; realistic: number; pessimistic: number }> {
  if (value === undefined) return taken(undefined);
  if (!isFieldBag(value)) return refused;
  const raw = value;
  const triple = { optimistic: 0, realistic: 0, pessimistic: 0 };
  for (const name of ['optimistic', 'realistic', 'pessimistic'] as const) {
    const weight = raw[name];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) return refused;
    triple[name] = weight;
  }
  return taken(triple);
}

function checkedSolutionRef(value: unknown): Checked<{ slug: string; url: string } | null> {
  if (value === undefined) return taken(undefined);
  if (value === null) return taken(null);
  if (!isFieldBag(value)) return refused;
  const raw = value;
  const slug = raw['slug'];
  const url = raw['url'];
  if (typeof slug !== 'string' || slug === '') return refused;
  if (typeof url !== 'string' || url === '') return refused;
  return taken({ slug, url });
}

/**
 * The `PATCH` body, or the 422 Elysia answered for the same body.
 *
 * Every field keeps the rule its schema line carried, and the comments that
 * said *why* each rule exists have moved with it — an unknown `estimateMethod`,
 * `depReach`, `estimateRounding`, `scheduleEngine` or `scheduleObjective` in
 * the column is read back as malformed data and throws on **every later read**
 * of the project, so refusing it is one 422 instead. For the two schedule
 * fields the database agrees: the migration's
 * `CHECK (schedule_engine IN ('fast','optimized'))` would refuse an unknown
 * value as a 500 on the write. The vocabularies are the arrays the CHECKs
 * enumerate, so the three boundaries cannot drift apart.
 */
function patchFrom(body: unknown): ProjectPatch | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const raw = body;
  const fields = {
    name: checkedString(raw['name']),
    restricted: checkedBoolean(raw['restricted']),
    estimateMethod: checkedFrom(ESTIMATE_METHODS, raw['estimateMethod']),
    // A **choice** the owner makes about their plan, not a scheduling parameter
    // a client sends per read — see
    // `docs/adr/0010-a-dependencys-reach-is-a-projects-choice.md`.
    depReach: checkedFrom(DEPENDENCY_REACHES, raw['depReach']),
    pertWeights: checkedWeights(raw['pertWeights']),
    estimateRounding: checkedFrom(ESTIMATE_ROUNDINGS, raw['estimateRounding']),
    startDate: checkedStartDate(raw['startDate']),
    solutionRef: checkedSolutionRef(raw['solutionRef']),
    // The three optimizer settings (tasks.md 3b.2), each optional and each
    // moving on its own: a project switched off keeps the engine and the
    // objective it was on, which is why they are three columns rather than one
    // nullable engine. They are **project settings**, so they arrive on this
    // route under its existing project-write authorization rather than on a
    // route of their own — a reader may not change them, and
    // `ProjectService.update` is where that is decided for every field alike.
    optimizationEnabled: checkedBoolean(raw['optimizationEnabled']),
    scheduleEngine: checkedFrom(SCHEDULE_ENGINES, raw['scheduleEngine']),
    scheduleObjective: checkedFrom(SOLVER_OBJECTIVES, raw['scheduleObjective']),
  };
  const patch: Record<string, unknown> = {};
  for (const [name, checked] of Object.entries(fields)) {
    if (checked.refused) return respond(422, { error: 'invalid_body' });
    // Absent stays absent rather than becoming an explicit `undefined`: the
    // store writes the columns a patch names, and `'startDate' in patch` is how
    // "take it off the calendar" is told apart from "do not touch it".
    if (checked.value !== undefined) patch[name] = checked.value;
  }
  return patch;
}

/** The create body: `{ name: string }`, or the 422 its schema answered. */
function nameFrom(body: unknown): { name: string } | RouteResponse {
  if (!isFieldBag(body)) return respond(422, { error: 'invalid_body' });
  const name = body['name'];
  return typeof name === 'string' ? { name } : respond(422, { error: 'invalid_body' });
}

const isRefusal = (parsed: object): parsed is RouteResponse => 'status' in parsed;

/**
 * What the document says about the two bodies now that the handlers check them.
 *
 * Both routes declared TypeBox schemas to Elysia, which both validated the body
 * and put a `requestBody` in the committed document. The route shape carries
 * no validator, so this is the mechanism the rest of the API already uses to
 * document a body it parses itself, caveat and all — the same move
 * `step.routes.ts` made.
 */
const NEW_PROJECT_BODY = checkedBody('The project’s name.', {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
});

const PATCH_BODY = checkedBody(
  'The project settings to change. Every field is optional; a field the body does not name is left alone.',
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      restricted: { type: 'boolean' },
      estimateMethod: { type: 'string', enum: [...ESTIMATE_METHODS] },
      depReach: { type: 'string', enum: [...DEPENDENCY_REACHES] },
      pertWeights: {
        type: 'object',
        required: ['optimistic', 'realistic', 'pessimistic'],
        properties: {
          optimistic: { type: 'number', minimum: 0 },
          realistic: { type: 'number', minimum: 0 },
          pessimistic: { type: 'number', minimum: 0 },
        },
      },
      estimateRounding: { type: 'string', enum: [...ESTIMATE_ROUNDINGS] },
      // `nullable` rather than the `anyOf: [..., { type: 'null' }]` the old
      // document carried, because Elysia types `detail` as an OpenAPI **3.0**
      // operation and `'null'` is not a 3.0 type. Same fact, the spelling the
      // version in use has.
      startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', nullable: true },
      solutionRef: {
        type: 'object',
        required: ['slug', 'url'],
        nullable: true,
        properties: {
          slug: { type: 'string', minLength: 1 },
          url: { type: 'string', minLength: 1 },
        },
      },
      optimizationEnabled: { type: 'boolean' },
      scheduleEngine: { type: 'string', enum: [...SCHEDULE_ENGINES] },
      scheduleObjective: { type: 'string', enum: [...SOLVER_OBJECTIVES] },
    },
  },
);

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
 * that write. `ProjectService.update` owns that second check — the routes
 * translate its refusal into a status rather than deciding anything themselves,
 * which keeps one copy of the rule for the mutations still to come.
 */
export function projectRoutes(
  auth: AuthService,
  projects: ProjectService,
  workItems: WorkItemService,
): Route[] {
  const guard = callerGuard(auth);
  return [
    {
      method: 'POST',
      path: '/api/projects',
      handler: guard('signed-in', async ({ body }, user) => {
        const named = nameFrom(body);
        if (isRefusal(named)) return named;
        return ok(await projects.create(named.name, user.id));
      }),
      documentation: { detail: { requestBody: NEW_PROJECT_BODY } },
    },
    {
      method: 'GET',
      path: '/api/projects',
      handler: guard('signed-in', async (_req, user) =>
        ok({ projects: await projects.list(user.id) }),
      ),
    },
    {
      method: 'POST',
      path: '/api/projects/:id/opened',
      handler: guard('signed-in', async ({ params }, user) => {
        // No authorisation check beyond authentication: this is the caller's own
        // navigation history, and every account may already read every project.
        // See `ProjectService.open`.
        const recorded = await projects.open(params['id'], user.id);
        return recorded ? noContent() : respond(404, { error: 'not_found' });
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:id/export',
      handler: guard('read-scope', async ({ params, query }) => {
        const format = query['format'];
        if (format !== 'json' && format !== 'markdown') {
          return respond(400, { error: 'unsupported_format' });
        }
        const found = await projects.read(params['id']);
        if (found === null) return respond(404, { error: 'not_found' });
        const tree = await workItems.tree(params['id']);
        if (tree === null) return respond(404, { error: 'not_found' });
        if (format === 'markdown') {
          // `text`, not `ok` with a content type: the Markdown table is already
          // on the wire's terms, and under Elysia a returned string went out
          // unchanged so this route passed its own suite while every other
          // binder would have answered a JSON-quoted document. Chunk 4 added
          // `RouteResponse.serialised` for exactly this route.
          return text(
            200,
            projectMarkdown(found.project, tree.workItems),
            'text/markdown; charset=utf-8',
          );
        }
        return {
          status: 200,
          body: { project: found.project, ...tree },
          headers: { 'content-type': 'application/json; charset=utf-8' },
        };
      }),
    },
    {
      // After `/:id/export` and `/:id/opened`, which is registration order made
      // load-bearing: Elysia matches in the order routes are registered and
      // `bindInProcess` walks the list, so a bare `/:id` registered first would
      // swallow both.
      method: 'GET',
      path: '/api/projects/:id',
      handler: guard('signed-in', async ({ params }) => {
        const found = await projects.read(params['id']);
        return found === null ? respond(404, { error: 'not_found' }) : ok(found);
      }),
    },
    {
      method: 'PATCH',
      path: '/api/projects/:id',
      handler: guard('signed-in', async ({ params, body }, user) => {
        const patch = patchFrom(body);
        if (isRefusal(patch)) return patch;
        const outcome = await projects.update(params['id'], user.id, patch);
        if (!outcome.ok) {
          // 422 is this route's default, and it is the caller's own two
          // mistakes: a date that is not a day, and weights that cannot average
          // a triple. `forbidden` and `not_found` are the shared arms — see
          // {@link statusForRefusal} for why a restricted project is 403 and
          // not 404.
          return respond(statusForRefusal(outcome.reason, 422), { error: outcome.reason });
        }
        return ok({ project: outcome.value });
      }),
      documentation: { detail: { requestBody: PATCH_BODY } },
    },
  ];
}
