# Route-level auth metadata, so both binders refuse 401 before 422

**TASK-262, blocking item 2. Written 2026-09-05 at `9e6ae5c5`, on
`change/be01-framework-independent-controllers`. This is a design for review, not a landed change.**

## The defect, reproduced

`/probe/guarded-sides` in `apps/be-01/src/http/binder.contract.test.ts` mirrors the shipped compare
route — the same `documentation: { query: COMPARE_QUERY }`, the same `guard('signed-in', …)`
outermost. Watched red on h2puni in chunk 15:

```
elysia      > answers 401 before 422 for an unauthenticated caller with a bad query   Expected 401, Received 422  ✗
in-process  > answers 401 before 422 for an unauthenticated caller with a bad query   ✓
```

An unauthenticated caller sending a malformed query learns the shape of the query before being told
it may not ask. Under the in-process binder they are told 401, as they were on `main`. The two
binders answer differently, which is the one thing this refactor claims cannot happen.

**Cause is structural, not a missing case.** The guard lives *inside* the handler, so it runs after
whatever validation the binder did on the way in. Elysia derives a validator from
`documentation.query` and runs it before the handler; the in-process binder has no query validator
at all, so its first refusal is the guard's. Same route list, two orderings, because the ordering is
the binder's and neither route nor guard has a say.

## Three patches, all measured dead (chunks 12 and 15)

1. **`t.Optional` on both compare properties** so only the handler's hand check refuses. Emitted and
   diffed against the committed document: two genuinely required parameters become
   `"required": false`. A document lie traded for a status bug. Reverted, `openapi.json` md5-verified
   byte-identical before anything was committed.
2. **Hand-written `detail.parameters`.** Elysia replaces the array wholesale; the operation keeps
   only the derived `id` path parameter.
3. **An emitter override.** `document-from-app.ts` is 44 lines and dumps what Elysia derives. There
   is no `parameters` seam to hook.

The first is the only one that changes behaviour, and it pays for it in the published document.

## The design

**`Route.auth` as declared metadata, honoured by each binder before its own validation.**

```ts
// http/route.ts — the framework-free file
export type RouteAuth = 'read-scope' | 'signed-in';

export interface Route {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  /**
   * What a caller must be before this route's request is validated at all.
   * Absent means the route is open …
   */
  auth?: RouteAuth;
  documentation?: { detail?: unknown; query?: unknown };
}
```

`RouteRequest` gains the authenticated caller the guard resolved, so the handler does not resolve it
twice:

```ts
export interface RouteRequest {
  …
  /** Set by the binder when {@link Route.auth} is declared; `undefined` otherwise. */
  caller?: Caller;
}
```

**Both binders run the same check, from the same place.** `callerGuard`'s body becomes a
binder-callable function over `(auth, headers, requires)` returning `Caller | RouteResponse`, so
there is exactly one implementation of "401 `unauthenticated`, then 403 `insufficient_scope`" and
neither binder owns a copy of it.

- **In-process** (`http/in-process/bind.ts`): after `matchPath`, before `decodeBody`. It has no
  validation of its own, so its answers do not move — which is the point: the binder that is already
  right stays right.
- **Elysia** (`http/elysia/bind.ts`): in `onRequest`, which runs **ahead of** the derived validator.
  `app.ts` already uses `onRequest` for `hasInvalidCookieOrigin`, so the seam is proven in this
  codebase rather than assumed. `beforeHandle` runs *after* validation and cannot carry this.

**The guards then come out of the handler wrappers.** `guard('signed-in', async ({ params }, user) =>
…)` becomes `auth: 'signed-in'` on the route plus a handler reading `req.caller`. 23 call sites
across 7 controllers — 21 `signed-in`, 2 `read-scope` — measured with
`git grep -oh "guard('[a-z-]*'" -- apps/be-01/src/controller`.

## Why this and not "leave it, it is only an ordering"

Because it is the acceptance criterion. The branch's claim is that a second binder over the same
route list produces the same API, and `binder.contract.test.ts` is the proof. Chunk 8 settled that a
contract recording two different answers is a record of a bug, not a contract — so this clause
cannot be written down as agreed-to-differ, and a `skip` marker is the same omission with a label.
The alternative is to ship a branch whose own contract suite has a hole exactly where the reviewer
found the defect.

It is also the smaller change of the two available. Making the in-process binder validate queries
the way Elysia does means reimplementing TypeBox refusal semantics in the framework-free path —
much more surface, and it puts validation in the route shape, which `route.ts` argues at length it
must not have.

## Sequencing, and the risk in it

**Chunk A — the seam.** `RouteAuth`, `Route.auth`, `RouteRequest.caller`, the shared check, both
binders calling it, and the `/probe/guarded-sides` fixture flipped from asserting only the signed-in
case to asserting the 401-before-422 clause under both binders. Watched red first: the clause fails
on Elysia and passes in-process, which is the divergence above.

**Chunk B — the migration.** The 23 call sites, controller by controller. `callerGuard` stays until
the last one moves and is deleted in the same chunk, so there is never a half-state where two
mechanisms both resolve a caller.

**The risk worth naming: a route that loses its guard silently.** Deleting `guard(...)` from a
handler while forgetting `auth:` on the route turns an authenticated route public, and every
existing controller test sends a valid token, so the suite stays green. Two controls, both in chunk
A so they are in place before a single site moves:

1. A test over the route list asserting the exact set of paths with no `auth` — the open routes,
   named — so a route that loses its guard fails a list comparison rather than needing a negative
   test of its own.
2. The `Caller` type on the handler stays non-optional where it is used, so a handler reading
   `req.caller` without `auth:` declared is a type error rather than a runtime `undefined`.

Control 1 is the load-bearing one; control 2 catches only the handlers that read the caller, and a
route guarded purely to *be* guarded reads nothing.

## Gates

Both chunks: `be-01:typecheck`, `be-01:lint`, `be-01:test`, `prettier --check` on h2puni at the
committed bytes, never on h1claw. `openapi.json` is expected **unchanged** by both chunks — `auth`
is not published, and if the document moves, something declared a validator by accident. That is a
cheap, sharp check and it runs in chunk A.

## Question for the reviewer

Is `Route.auth` the right home, or should the route list stay auth-free and the app compose a
guarded list — `withAuth(routes)` returning a new list whose handlers are wrapped — so the ordering
is decided once at wiring time instead of by each binder? The wrapper keeps the binders ignorant,
which is attractive; the objection is that a wrapper *is* a handler, so it lands back inside the
handler and after Elysia's validator, which is the bug. State plainly if that objection is wrong.

---

## Addendum, 2026-09-05T23:03Z — found while the reviews were running

**Both review seats were launched against the text above and have not seen this section.** It is
appended rather than folded in so their verdicts stay readable against what they actually read.

**There is already a second auth mechanism, and it already does the thing this design proposes.**
`app.ts:170` runs an `onRequest` that, for any request matching `requiresWriteScope`
(`app.ts:276` — a `DELETE|PATCH|POST|PUT` under `/api/` that is not `/api/auth/*` and not
`/api/smoke/echo`), resolves the caller and answers 401 `unauthenticated` or 403
`insufficient_scope` **before Elysia parses or validates the body**. The comment at `app.ts:176`
says so in as many words and gives this design's own reason: "A reader gets the authorization
answer without letting an invalid body route around the write-scope boundary as a 422."

Two consequences, and the second is the one that matters.

1. **The seam is not merely proven, it is occupied.** Question 1 to the reviewers — does `onRequest`
   run ahead of the validator — is answered in this repo's own code, not just in Elysia's docs.

2. **The divergence is narrower than it looked, and the fix's urgency with it.** Every write route
   already gets 401 before validation under Elysia, from the `onRequest` above. So the
   401-before-422 hole is confined to routes that are **guarded, carry a query schema, and are not
   writes** — reads. `GET /api/saved-plans/compare` is the one the fixture reproduces. This does not
   make the clause optional (the contract suite still records two answers for one route list), but
   it does mean the branch is not shipping unauthenticated write access, and the design's framing
   should not be read as saying otherwise.

**And it opens a question the text above does not answer: `Route.auth` overlaps
`requiresWriteScope`.** A path-prefix predicate in `app.ts` deciding which routes need a scope is
exactly the route knowledge this branch spent twenty chunks moving into the route list — it is one
`path.startsWith` away from being wrong about a new route, silently, with no test that names the
route. Three ways to go, and the choice belongs in the review rather than in a fix chunk:

- **Subsume it.** `Route.auth` gains `'write-scope'`, every write route declares it, and
  `requiresWriteScope` is deleted. Most honest, largest chunk B, and the migration's silent-loss risk
  applies to a *security* boundary rather than only to 401 ordering — which raises the bar on the
  route-list control, not the design.
- **Leave it beside.** `Route.auth` covers `signed-in`/`read-scope`, `requiresWriteScope` keeps the
  write boundary. Smallest change; the cost is two mechanisms answering the same question in two
  places, which is the state that produced this defect.
- **Invert it.** Keep the predicate but derive it from the route list rather than from path shape,
  so it cannot disagree with a route that exists.

I have not chosen. Whichever way the review goes, chunk A should not start until it does, because
`Route.auth`'s value set is the first line of the change.

---

# Version 2 — the check stays app-level, and the route list supplies the predicate

**Supersedes everything above. 2026-09-05T23:10Z, written against the Gemini plan verdict
(`queue/reviews/t262-item2-plan-gemini.md`, CHANGES REQUIRED, three Critical). Version 1 is left
in place unedited because it is what the seat reviewed.**

## What killed version 1

1. **`onRequest` is not a route-level hook.** It is application/plugin level and runs *before Elysia
   matches a route*, so a `bindElysia`-registered one would have to re-implement path matching,
   would fire once per mounted controller on every request, and has no channel to hand a resolved
   caller to `ctx`.
2. **Neither binder receives `AuthService`,** and `Route` cannot carry a service without breaking
   the isolation `route.ts` exists to hold.
3. **Both silent-loss controls were false comfort** — paths instead of `(method, path)`, and an
   optional field on an interface instead of a union.

## The correction, and it makes the change much smaller

**Finding 1 is only fatal to putting the hook in `bindElysia`.** The hook this design needs already
exists, at the level Elysia actually supports, in the place that already has `AuthService` in
scope: `app.ts:170`. So version 2 does not move the check into a binder at all.

**And the in-process binder needs no change whatsoever.** It has no validator, so its first refusal
is already the handler's guard — 401, which is the right answer and the one `main` gave. Version 1
proposed changing the binder that was already correct.

So the whole change is: **the app-level `onRequest` stops deciding auth from path shape and starts
reading it from the route list.**

```ts
// http/route.ts — framework-free, data only, no service
export type RouteAuth = 'read-scope' | 'signed-in' | 'write-scope';
```

- Every route declares `auth` — as a **required** field, see the controls below.
- `app.ts` assembles the same lists it already mounts into one `(method, path) → RouteAuth` table
  and hands it to the existing `onRequest`, which resolves the caller and answers 401/403 before
  Elysia parses or validates anything.
- `requiresWriteScope`'s `path.startsWith('/api/')` heuristic (`app.ts:276`) is **deleted**. It is
  the same decision, made from path shape instead of from the routes, and it is one new path prefix
  away from being silently wrong.
- **The handler guards stay.** They are not the mechanism any more; they are defence in depth, and
  removing 28 of them is the migration that made version 1 a two-chunk change with a security-shaped
  failure mode. Auth being checked twice under Elysia is already true today for every write.

The in-process binder keeps answering from the handler guard. Both binders then refuse 401 before
422 — Elysia because the hook precedes its validator, the in-process one because it has no
validator — which is the clause `/probe/guarded-sides` asserts.

## Controls, rewritten to hold

1. **`auth` is required on `Route`, not optional.** A route that declares nothing does not compile.
   Open routes say so: `auth: 'open'` joins the union. This is the discriminated-union point from
   finding 3, in the only form that covers routes whose handler never reads the caller — which is
   6 of the 28.
2. **The table is asserted by `(method, path, auth)` triples**, not by the set of open paths. Method
   collisions on one path (`POST` and `GET /api/auth/login`, `GET` and `PATCH /api/projects/:id`)
   are the blind spot finding 3 named, and a triple has no such spot: a `read-scope` route degraded
   to `signed-in` moves a row.
3. **A test asserts the table covers every mounted route.** The route lists are assembled
   per-controller and `/health` is attached to Elysia directly (`app.ts:242`), so "every route" is a
   claim that needs its own check rather than an assumption — Gemini's point about the absent single
   list.

## What this costs

One chunk, not two. `route.ts` gains a type and a required field; every route literal gains one
line; `app.ts` gains the table and loses `requiresWriteScope`; `binder.contract.test.ts` gains the
401-before-422 clause and the three controls. No binder signature changes, no `AuthService`
injection, no `callerGuard` deletion, no 28-site migration.

**Still open, for the next review:** whether `write-scope` belongs in the same union as
`signed-in`/`read-scope` — they are different questions (what you are vs what you may do) and
merging them may be the same conflation `requiresWriteScope` made. Two fields (`auth` and `scope`)
is the alternative. Also `Caller` is not a type in this repo; it is `AuthenticatedUser`
(`service/auth.service.ts:12`), and version 2 does not put it on `RouteRequest` at all.

**This version has not been reviewed. Re-run the plan gate on it before any implementation.**

---

# Constraint 2 is measured, and both seats were wrong about it

**2026-09-05T23:15Z. Read from Elysia 1.4.28's compiled handler generator, not from its docs, and
not from a running probe — this is a source reading and the next chunk must confirm it with a
watched red before a design is built on it.**

Both reviews said the same thing about `transform`: it runs before validation but "cannot
short-circuit or return an early HTTP response" (Gemini, question 1) — so the only pre-validation
seat was the pre-routing, app-level `onRequest`, and that is what made v1 and v2 both unbuildable.

**The generator says otherwise.** In
`/home/claw/wd/puni/wbs-tool-v1/node_modules/elysia/dist/compose.mjs`:

- Route-local `transform` hooks are emitted at **`:524-544`**.
- The validator block — headers, then query, body, params — begins at **`:546`** (`if (validator)`).
  So `transform` is generated **above** validation, per route.
- Each transform's result is wrapped: **`:541`**
  `if(transformed instanceof ElysiaCustomStatusResponse){` + `mapResponse("transformed")` + `}`.
- `mapResponse` (**`:362-365`**) emits a literal **`return`**:
  ``return `return ${response}` `` — or `const _res=…; …; return _res` when an `afterResponse` hook
  exists.

So a route-level `transform` that returns an `ElysiaCustomStatusResponse` — what `status(401, …)`
produces — **returns from the composed handler before the validator runs**. That is a per-route,
pre-validation, short-circuiting hook, which is exactly the seat v1 wanted and could not find.

**What it satisfies, from the constraint list in the task log:**

- **Constraint 1** — it lives in `bindElysia`'s existing per-route `hook` object, beside the `query`
  schema that is already passed there. `binder.contract.test.ts` constructs `bindElysia(routes)` and
  gets it. No `app.ts` involvement.
- **Constraint 2** — pre-validation and route-local at once, so no hand-rolled path matching and no
  ten-hooks-per-request. The context `c` is the route's own, so the resolved caller can be assigned
  to it rather than smuggled through a `WeakMap`.

**What it does not settle, and what a v3 still owes:**

- Constraint 3 stands unchanged: the in-process binder answers 400 for a malformed body before its
  guard (`in-process/bind.ts:50`), so the auth check's position relative to `decodeBody` is its own
  decision with its own contract clause.
- Constraints 4, 5 and 6 stand: write-scope's home, `(method, path, exact auth)` triples, and the
  two named refusals (`invalid_token` on `GET /api/auth/me`, the write scope on `POST
  /api/projects/:id/opened`).
- **This reading is not a measurement of behaviour.** The next chunk starts by adding a `transform`
  to the `/probe/guarded-sides` fixture that returns a 401 and asserting the malformed query gets
  401 rather than 422 under Elysia. If that red does not go green, this section is wrong and the
  constraint list is right as it stands.
