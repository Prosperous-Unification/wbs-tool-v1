import type { DocumentDecoration } from 'elysia';

type RequestBodyDoc = NonNullable<DocumentDecoration['requestBody']>;
type BodySchema = NonNullable<
  Extract<RequestBodyDoc, { content: unknown }>['content'][string]['schema']
>;

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
 *
 * **Under `http/elysia/` and not `openapi/`, because of the one import at the
 * top.** `DocumentDecoration` is a type-only import — it costs nothing at run
 * time — and it still fails the grep acceptance criterion #1 names,
 * `git grep -l "from 'elysia'" apps/be-01/src`. The type is Elysia's shape for
 * a route's `detail`, so the file belongs beside the binder that speaks that
 * dialect, next to `query-schemas.ts`, which moved here for the same reason.
 * The alternative — restating `DocumentDecoration`'s inner shape structurally
 * in a framework-free file — would be a copy of a type this app does not own,
 * silently right until Elysia changes it.
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
 * The same `schema` object under all three keys would serialise correctly, and
 * is still spelled out three times: a shared reference is one mutation away from
 * three routes' worth of surprise, and this file is copied from more than it is
 * read.
 */
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
