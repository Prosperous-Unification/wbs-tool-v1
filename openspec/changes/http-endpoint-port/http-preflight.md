# HTTP Wave 1 foundation preflight

PRE-INTEGRATION foundation observations, 2026-09-06, refactoring worktree. Calendar markers4051512c and OIDC fixes39e53dda/a91f831b were fetched afterward; see http-wave1-draft/design.md fetched-commit supplement for affected seams. Ten route families and the old operation inventory below are historical, not post-merge completeness claims. No tracked changes, broad tests, typecheck baseline, dependency installation or subagents. Probes used installed ArkType 2.2.0 and Elysia via Bun; their source and declarations were read locally. The normative ports plan remains authoritative.

## Reuse and migration seams

TASK-262 already made all controllers framework-independent **route lists**: `controller/{smoke,step,work-item,history,solution,saved-plan,project,directory,internal,auth}.routes.ts`. The plan's old `*.controller.ts` implementation paths must not be recreated. Controller tests retain their older names.

- `http/route.ts` is the existing framework-free boundary, but its `RouteRequest` has dictionary params/query, unknown body, and its `RouteResponse` has number status/unknown body. It deliberately carries no validation. This is a useful migration boundary, not the requested typed endpoint contract.
- `http/elysia/bind.ts` and `http/in-process/bind.ts` already consume the same route list. `http/binder.contract.test.ts` exercises path matching, repeated queries/form fields, HEAD, 204, text and three Set-Cookie values. Reuse those concrete arrangements when testing the new adapter.
- Existing `Route.preflight` is an ordering hint duplicated by `callerGuard`, and Elysia runs it in **transform after parsing**. It cannot serve the new authoritative pre-parse policy runner. Its in-process counterpart runs before decoding, a documented dormant divergence for body-taking routes.
- `app.ts:247` already has real origin/write-scope enforcement in `onRequest`; `http/caller.ts` handles signed-in/read-scope checks inside route handlers. Replace them only after the shape policy matrix covers their existing paths, including auth's special origin requirements and internal identity.
- `http/response.ts::toResponse` appends cookies correctly and preserves explicit serialized text. It also treats **every null body as empty**, even status 200. It therefore cannot implement `EMPTY != JSON null` unchanged. The new ordered header tuples can reuse the append behavior, but the old headers-record/cookies-special-case model is not the final contract.
- `mountedRouteLists` and `app.routes.test.ts` provide the real composition/reachability seam. Preserve registration ordering while routes migrate. Keep separate shape-to-endpoint coverage and real mounted-path coverage; neither proves the other.
- `http/body-doc.ts`, `http/elysia/query-schemas.ts`, `controller/plan-command-schema.ts` and the OpenAPI plugin are existing parallel documentation/validation declarations that Wave 1 eventually removes. Their documentation contains historical descriptions already stale after TASK-262; code and mounted tests are the current evidence.
- `libs/contracts/src/index.ts` currently exports only errors/internal/ws modules. Existing `ErrorCode` is the small realtime error vocabulary, not the HTTP Refusal union. Add HTTP contracts without accidentally repurposing it or importing backend repository/service types into contracts.
- Current route literals do not provide operationIds; Elysia document generation has supplied them. The new shapes must explicitly own stable literal operationIds, with MCP's existing expected tool list checked before names change.
- MCP's `openapi-tools.ts` requires an **inline** JSON object body schema, reads its properties/required directly, and rejects missing operationId. It does not resolve a top-level body `$ref` or infer properties from a top-level union. Nested `commands.items.anyOf` is compatible with its object-body requirement.
- FE `api.ts`, `wbs-api.ts`, `saved-plan-api.ts` still own handwritten transport and error handling. `wbs-api.ts` still contains URL-only `readsInFlight`. HTTP Wave 1.4 must wait for R1 and carry its pending-scope/held-response negatives; no deduplication belongs in the new generic transport.

## Installed schema capabilities — observed, not assumed

Commands: `bun /private/tmp/http-schema-preflight.ts` and `bun /private/tmp/http-schema-direction.ts`, both exit 0. Scripts/logs remain in `/private/tmp` for this session.

1. **Deep body strictness matters.** On a body with `commands[0].extra`, `.onUndeclaredKey('reject')` accepted the nested extra. `.onDeepUndeclaredKey('reject')` refused at `commands[0].extra`. Apply strictness throughout object/union/array declarations, not only the outer body.
2. **Response tolerance means preserving extras.** `.onDeepUndeclaredKey('ignore')` accepted and retained both outer and nested extras. This is the desired additive-deploy tolerance; `delete` is a different, mutating-output operation. Validate known field types while allowing undeclared response fields, including refusal bodies.
3. **Nested document emission works.** `toJsonSchema()` emitted an inline object containing `commands: { type: 'array', items: { anyOf: [...] } }`, both discriminant arms, the optional `note`/`cascade` fields, and deep `additionalProperties: false`. Default target is draft 2020-12.
4. **Standard Schema itself remains validation-only.** Installed ArkType additionally implements **Standard JSON Schema**, exposing `schema['~standard'].jsonSchema.input/output`. Its runtime properties were `vendor, version, validate, jsonSchema`. Do not type the generic document emitter against this ArkType extension: preserve the planned separate descriptor on SchemaShape.
5. **Direction is observable.** A string-to-length morph with `.to('number')` produced an input descriptor of string and output descriptor of number. Direct `morph.toJsonSchema()` threw `ToJsonSchemaError` with code morph.
6. **Defaults also distinguish directions.** `{ count: 'number = 3' }` produced optional count on input and required count on output. Direct conversion emitted optional count plus default 3. A one-generic StandardSchemaV1<T> assumes input/output equality and cannot describe this honestly.
7. **Unsupported conversion must not silently widen.** A numeric custom predicate threw ToJsonSchemaError in direct, input and output conversion. More dangerously, an unvalidated user morph's **output conversion returned only `$schema`**, an unconstrained descriptor, instead of throwing. A converter that merely catches thrown errors is insufficient. Keep initial wire declarations free of transforms/defaults unless the wrapper explicitly models input/output and verifies output introspectability. A direct representability check rejects arbitrary morphs; direction-specific projection alone can hide them. Do not install a fallback returning `{}`.
8. ArkType's Standard JSON Schema converter refused `target: 'openapi-3.0'` with ParseError; supported targets are draft-2020-12 and draft-07. Emit an OpenAPI 3.1-compatible document if using these descriptors, rather than pretending they are OpenAPI 3.0 schemas. Existing `openapi-types` BodySchema is OpenAPIV3 and is not the right universal JsonSchema type; ArkType publicly exports JsonSchema.
9. `StandardSchemaV1` and `StandardJSONSchemaV1` types are exported from installed `@ark/schema`; `arktype` exports JsonSchema but does not directly export those interface names. `@standard-schema/spec` is not installed. Decide the explicit dependency/re-export boundary before importing a transitive package throughout contracts.
10. Standard validation permits asynchronous results by contract even though these installed ArkType examples were synchronous. The generic adapter/client must await validation and distinguish issue-bearing failure from value-bearing success. Do not emit the ArkType error object: the observed failure included its original data payload.

## Type-negative pitfalls and probe output

Executed with `bunx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler` against each tiny `/private/tmp` file; these are not repository timing baselines.

- `http-never-read.ts` declared `{ principal: never }`, read `input.principal`, and assigned it to `{ id: string }`: **exit 0**. Never is assignable to every type; it does not prohibit property access.
- `http-omitted-read.ts` conditionally omitted the principal field for an unauthenticated input, then read it: **exit 2, TS2339**, property principal does not exist on `{ params: {} }`.

Implement the normative “cannot read principal” requirement by conditionally omitting the property, not literally copying the sketch's `principal: never`. Preserve the literal policy tuple (`const` inference), otherwise a widened `RequestPolicy[]` can claim an identity policy that the actual empty tuple lacks.

Further pitfalls to pin in the first implementation tests:

- Derive params from a literal path. A generic `string` path or Record<string,string> fallback makes `params.foo` compile. A params schema must have exactly the path's keys, not merely be structurally assignable to a type allowing additional keys. Prevent the handler/params schema from widening the path during inference (curried shape binding or NoInfer at the dependent positions).
- Bind an endpoint to the exact shape literal. Widening to the broad EndpointShape constraint loses operationId keys, refusal status/body correlation and policy tuple information.
- Derive each refusal variant from its literal status and schema **together**. Independent `status: RefusalStatus` and `body: Refusal` unions allow 400 throttling and 429 snapshot_busy. Existing `statusForRefusal(reason, otherwise)` is intentionally route-dependent, so a global code-to-status map would lose legitimate context.
- A marker `{ ok: true }` alone is insufficient if ResponseOf becomes unknown or a success object structurally accepts the refusal shape. Run negatives against actual bind/handler inference, not stand-alone illustrative aliases or assertions cast to the target type.
- Model text/empty/JSON success arms by the shape. The sketch's unconditional 200/201/204/302 union would let every endpoint return redirects and empty responses. D26 requires status-specific variants; refusal validators are required just as success validators are.
- Compile negative fixtures in a target that really reads them. Existing contracts root tsconfig references lib and spec projects, but an unreferenced throwaway file proves nothing about the gate. Pair @ts-expect-error checks with injected widening so the unused directive fails, and record the diagnostic at its intended line.

## Adapter ordering probe

`bun /private/tmp/http-policy-preflight.ts`, exit 0, used actual installed Elysia app.handle with the malformed JSON bytes `{`:

- onRequest refusal: **403**, `{"error":"insufficient_scope"}`.
- beforeHandle refusal: **400**, `Bad Request` (parser answered first).

The normative ordering remains correct, but the plan's guessed injected result “422” is not what current Elysia emitted for malformed JSON. The production negative should require the authorized pre-parse 403 and record the actual fault's 400. Do not write a Proof comment from the guessed status.

## First implementation slice

Start Wave 1.1 with no bulk controller move:

1. `libs/contracts/src/http/{schema-shape,endpoint-shape,refusal}.ts` and focused tests: declaration-bound descriptor generation, deep strict body/deep tolerant response variants, literal paths and status/body variants. Export through contracts index. Establish unsupported predicate/morph and nested-command/MCP body negatives immediately.
2. `apps/be-01/src/http/endpoint.ts` and typed fixture tests: EndpointInput with conditional principal omission, bind, EMPTY, ordered headers and HttpReply. The initial identity representation can reuse authenticated user semantics without importing auth-service implementation into contracts.
3. New `http/elysia/mount.ts` plus adapter matrix tests, keeping old binders for unmigrated routes. Validate policy ordering, origin, account-store exception propagation, 429, 503, 204 vs JSON null, 302 Location and three Set-Cookie headers before touching production route factories.
4. Only then migrate `controller/smoke.routes.ts` as the first shape/endpoint and drive both literal handler input and real app.handle. Its current schema/error-message behavior changes to the declared Refusal envelope; record that intentional wire-test rewrite.

Parent must first record clean be-01 and fe-01 tsc wall-time baselines, then compare after generics. No such broad timing run was performed in this preflight. Before broad migration settle the exact RefusalDetail inventory, including batch at/kind and existing derived-field codes; a blanket generic invalid-body mapper must not silently erase a named refusal that the plan's own negative expects to survive.

## Incoming OIDC preservation supplement — 2026-09-06

Source review of d08a6ad6 before its integration supersedes the old transaction-loss assumptions. `OidcTransactionStore.consume` returns consumed, missing, expired or state_mismatch. Expiry deletes before comparison; a live mismatch preserves the record, and a successful match consumes exactly once. The callback keeps the binding cookie on mismatch while missing/expired transactions still clear it. All these invalid transaction responses remain empty400 upstream; Wave1 explicitly changes their bodies to one declared public refusal without changing cookie/transaction timing or exposing the internal outcome.

Keep HEAD405/Allow and duplicate-key400 before consumption, with no cookie clearing. Preserve the forged callback followed by an honest callback using the cookie surviving the first response; an unconditional cookie resend cannot prove recovery after an erroneous clear. Keep account resolution outside the exchange catch (R3), held password admission (R5), common configured origin and trailing-slash login/register protection. This supplement is source-backed integration guidance, not a merged-tree test result.
