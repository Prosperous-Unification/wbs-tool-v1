import type { OpenAPIV3 } from 'openapi-types';

/**
 * A JSON Schema object as this app writes one for a documented request body.
 *
 * Taken from `openapi-types` and not restated here, because a hand-written
 * copy of a schema type is wrong the first time the standard moves and nothing
 * says so. It is also not taken from Elysia: `DocumentDecoration` is
 * `Partial<OpenAPIV3.OperationObject>`, so the shape these helpers build was
 * never the framework's to begin with — it is OpenAPI's, and `openapi-types`
 * is the package that owns it. Depending on the vocabulary instead of the
 * server is exactly the distinction this refactor is about.
 */
export type BodySchema = OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject;

/**
 * A documented request body: OpenAPI's `requestBody` object, in the two shapes
 * this app emits.
 *
 * **This file is framework-free on purpose, and that is a correction rather
 * than a preference.** Until the terminal review it lived at
 * `http/elysia/hand-parsed-body.ts` and took `DocumentDecoration` from the
 * framework package as a type-only import, on the argument that a type import
 * costs nothing at run time. It costs nothing at run time and it still made
 * `git grep -l elysia apps/be-01/src/controller` non-empty, which is acceptance
 * criterion #1 word for word; six route modules import these helpers. The
 * old note admitted the grep failure and kept the file anyway, so a criterion
 * this branch exists to meet stayed open for fourteen chunks.
 *
 * The objection the old note raised against moving — that restating
 * `DocumentDecoration`'s inner shape structurally would be a copy of a type
 * this app does not own, silently right until Elysia changes it — was correct,
 * and nothing here is restated. The shape is `openapi-types`', which is where
 * Elysia's own `DocumentDecoration` gets it, and
 * `http/elysia/body-doc-conformance.ts` still asserts the two agree: if a
 * framework upgrade narrows what it accepts, `be-01:typecheck` fails in that
 * one file, naming the upgrade. Declared where no server framework is
 * imported, proved where one is.
 */
export interface RequestBodyDoc {
  required: boolean;
  description: string;
  content: Record<string, { schema: BodySchema }>;
}

/**
 * The sentence every hand-parsed body in this API needs, written once.
 *
 * Two routes parse their own bodies: `POST /api/projects/{id}/commands` and
 * `POST /api/directory/commands`. Since `plan-commands` every plan and directory
 * write arrives as a command inside one of them, parsed by the guards the single
 * routes used to hold — this comment named those six work-item writes, the
 * capacity PUT and the priority-band PUT for three releases after the last of
 * them was retired. `openapi-document.test.ts`'s `describes every hand-parsed
 * body without declaring it` is the list that cannot go stale, because it reads
 * the document.
 *
 * The reason is on each parse function and it is the same reason: Elysia strips
 * unknown properties before a handler runs, so a
 * guard written after `{ body: t.Object(...) }` never sees the field it refuses
 * and reads as though it works. `number_is_derived`, the priority floor and the
 * parallelism range are all guards this repo has watched fail under injection;
 * declaring these bodies to Elysia would delete them silently.
 *
 * So the schema in the document is **documentation**. Saying so out loud is the
 * point: a reader who takes it for the validator will send a field this API
 * refuses and read the 400 as a fault in the API.
 */
const PARSED_BY_HAND =
  'The schema here is documentation, not validation. This route parses its own ' +
  'body so that a field this API derives is refused rather than quietly ' +
  'dropped, which is what an Elysia body schema would do to it. Fields not ' +
  'named here are ignored; the ones named are checked, and a bad one answers ' +
  '400 with a code from the list above.';

/**
 * A documented request body for a route that validates itself.
 *
 * The prose comes first and the caveat last, because a reader who stops early
 * should still have read what the fields mean.
 */
export function handParsedBody(description: string, schema: BodySchema): RequestBodyDoc {
  return {
    required: true,
    description: `${description}\n\n${PARSED_BY_HAND}`,
    content: { 'application/json': { schema } },
  };
}

/**
 * The same job for the **other** class of self-checking body, and the reason
 * this file has two helpers instead of one shared sentence.
 *
 * {@link PARSED_BY_HAND} was written for the two command routes and every clause
 * in it is true of them: they hand-parse *so that* a derived field is refused
 * rather than dropped, and a bad field answers 400 with a code. Neither clause
 * is true of the bodies below. These were `t.Object(...)` schemas Elysia
 * validated until this branch moved them into their handlers — they parse by
 * hand because a route module cannot declare a validator to a framework it does
 * not import, they ignore unknown fields exactly as the schema did, and a bad
 * one answers **422** with `{ "error": "invalid_body" }`, which is the status
 * Elysia's own schema refusal produced and the one clients already branch on.
 *
 * Borrowing the shared sentence to save four lines put a false statement about a
 * refusal into the published API document on **six operations** — measured on
 * the document itself, `git diff origin/main...HEAD -- apps/be-01/openapi.json`
 * showing six additions of "a bad one answers 400" and none removed. Both review
 * seats found it independently. `auth.routes.ts` avoided the trap by hand and
 * wrote down why; this helper is that reasoning made reusable, so the next
 * migrated body cannot fall into it by copying its neighbour.
 */
const CHECKED_BY_HAND =
  'The schema here is documentation, not validation. This route checks its own ' +
  'body: the fields named here are checked and everything else is ignored, and ' +
  'a body that is not an object, or that names one of these fields with the ' +
  'wrong type, answers 422 with `{ "error": "invalid_body" }`.';

/**
 * A documented request body for a route that checks itself and refuses with 422.
 *
 * Same shape as {@link handParsedBody} — prose first, caveat last — and a
 * different caveat, which is the entire point of it existing.
 *
 * **Three media types, where {@link handParsedBody} declares one.** Not a
 * difference in taste: it is what each set of routes accepts. On `main` these
 * bodies were `t.Object(...)` schemas and Elysia derived `application/json`,
 * `application/x-www-form-urlencoded` and `multipart/form-data` for every one of
 * them; moving the checks into the handlers dropped the declarations while the
 * app kept serving all three, which the in-process binder's `decodeBody` now
 * measures and matches. The two `handParsedBody` command routes take a
 * `{ commands: [...] }` body that no form encoding can express, they declared
 * JSON alone on `main`, and they still do.
 *
 * A route whose schema names a nested object — `PATCH /api/projects/{id}` and
 * its `pertWeights` — declares the form types anyway, because `main` declared
 * them and a refactor does not narrow a published API on the way past. Whoever
 * wants that narrowing gets it as its own change, with the clients told.
 *
 * **All three keys hold the same `schema` object**, and an earlier version of
 * this note claimed the opposite — that the schema was "spelled out three
 * times" to keep one mutation from surprising three routes. It never was: the
 * three entries are three references to the one argument, as the code below
 * shows, so the note described a safety the file did not have. Serialisation is
 * unaffected either way; a caller that mutates the schema it just passed in
 * would see it in all three media types, and no caller does.
 */
/**
 * The third caveat, and the reason it is a third rather than a reuse.
 *
 * {@link CHECKED_BY_HAND} promises `{ "error": "invalid_body" }`. The calendar
 * marker routes do not answer that: their refusal is a **row of the spec's
 * refusal table** — `{ "error": "malformed", "field": "date" }` and its five
 * siblings, including a `contrast` reason that is not a shape complaint at all
 * — and the fields were checked that way while Elysia still validated their
 * types. Borrowing the shorter sentence would publish a refusal body those
 * routes never send, which is the exact defect `checkedBody`'s own note
 * records: six operations documented as answering 400, on the strength of a
 * neighbouring helper reading close enough.
 *
 * So the rule this file enforces is unchanged — one caveat per class of
 * refusal, written where the document is built — and this is the class the
 * marker routes are in. A second route family answering a typed table joins it
 * here rather than spelling a fourth sentence in a controller.
 */
const TABLE_REFUSED_BY_HAND =
  'The schema here is documentation, not validation. This route checks its own ' +
  'body: the fields named here are checked and everything else is ignored, and ' +
  'a body that is not an object, or that names one of these fields with the ' +
  'wrong type or an unusable value, answers 422 with an `error` naming the ' +
  'fault and a `field` naming the member it blames.';

/**
 * A documented request body for a route that checks itself and refuses with a
 * typed row of its own refusal table — see {@link TABLE_REFUSED_BY_HAND}.
 *
 * Three media types for {@link checkedBody}'s reason: these bodies were
 * `t.Object(...)` schemas from which Elysia derived `application/json`,
 * `application/x-www-form-urlencoded` and `multipart/form-data`, the app still
 * serves all three, and a refactor does not narrow a published API on the way
 * past.
 */
export function tableRefusedBody(description: string, schema: BodySchema): RequestBodyDoc {
  return {
    required: true,
    description: `${description}\n\n${TABLE_REFUSED_BY_HAND}`,
    content: {
      'application/json': { schema },
      'application/x-www-form-urlencoded': { schema },
      'multipart/form-data': { schema },
    },
  };
}

export function checkedBody(description: string, schema: BodySchema): RequestBodyDoc {
  return {
    required: true,
    description: `${description}\n\n${CHECKED_BY_HAND}`,
    content: {
      'application/json': { schema },
      'application/x-www-form-urlencoded': { schema },
      'multipart/form-data': { schema },
    },
  };
}
