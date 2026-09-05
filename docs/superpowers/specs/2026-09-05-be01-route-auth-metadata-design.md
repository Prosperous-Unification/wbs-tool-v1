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
