## Context

Read against working HEAD `339708fa` on 2026-09-08; application edits were present and were not changed. Historical §58 is a handoff, not the current file map. `libs/contracts/src/http/plan-command-shapes.ts` already has ArkType declarations and `PlanCommandWire`. `http/refusal.ts` carries another handwritten kind union. Backend semantic parsing is still in `controller/work-item.routes.ts`; `service/plan-command.ts` holds normalized commands and `plan-commands.ts` dispatches them. No TypeBox or Elysia export experiment is needed.

## Goals / Non-Goals

Complete the single vocabulary without changing wire behavior. No command proliferation or new MCP tools. Contracts own structural inputs; application bindings own semantic normalization and service invocation, per [ADR 0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md).

## Decisions

Use `libs/contracts/src/commands/definitions.ts` for `commandDefinitions`: a const object keyed by the existing 36 literal kinds. Each entry has `schema`, `scope: 'project' | 'directory'` and `description`. The schema retains its literal kind, existing description and every currently optional field. A typed `defineCommand(kind, definition)` checks key/discriminator agreement. `PlanCommandWire`, `PlanCommandKind` and `PLAN_COMMAND_KINDS` derive from this object. `http/plan-command-shapes.ts` becomes the adapter composing the existing structural batch union from these definitions; `http/refusal.ts` imports the derived kind as a type only, avoiding a runtime cycle.

Do not turn semantics into schema morphs: the descriptor boundary explicitly rejects transforms. Keep all current structural acceptance controls, including negative numeric values and unrecognized semantic metric strings, for the existing semantic parser to refuse in its current order. Structural malformed bodies still receive the mounted route's existing envelope. All commands undergo semantic parsing before the runner applies its 200-command cap; a malformed command later in a 201-command request retains precedence over that cap.

At the post-core paths, split pure semantic functions from `libs/core/src/http/work-item.routes.ts` into `libs/core/src/service/command-normalizers.ts`. Its `commandNormalizers` is a literal record checked against every definition's inferred wire type. Infer normalized `PlanCommand` as the union of its return types; do not maintain another normalized union. Domain field aliases replace imports of storage-defined patch types where necessary. The existing route parsers remain shared helpers for route and command semantic validation.

`libs/core/src/service/command-bindings.ts` exports `bindCommands(graph): CommandBindings` with this exact input/output correlation:

```ts
type CommandFor<K extends PlanCommandKind> = PlanCommand & { kind: K };
type AppliedFor<K extends PlanCommandKind> = AppliedCommand & { kind: K };
type CommandBindings = {
  [K in PlanCommandKind]: (
    command: CommandFor<K>,
    context: CommandContext,
  ) => Promise<AppliedFor<K>>;
};
```

Intersection intentionally narrows existing grouped-discriminator arms; `Extract<AppliedCommand, { kind: K }>` would return `never` for a plain kind currently grouped with other literals. A handler must retain its own literal kind in the returned value, not widen the return to `AppliedCommand`. `CommandContext` owns actorId, nullable projectId, index, ref lookup/mint and refusal translation. Project-required admission derives from definition.scope. Each kind has one binding; preserve create/duplicate duplicate-ref checks before writes. `plan-commands.ts` owns ordered iteration, collection, unit-of-work decision and post-commit publication only.

Keep the discriminator relationship explicit. A single audited generic dispatch helper is permitted to bridge TypeScript's indexed-union limitation, with an adjacent boundary comment and compile-negative fixtures proving wrong-kind input and wrong-kind response cannot be bound. Do not distribute casts into 36 handlers or accept an untyped catch-all. Adding a temporary definition with no normalizer or handler must fail typecheck at the two respective records.

Directory create/patch/delete handlers share helpers only where their input and return types agree; preserve the special person/team membership rules. Existing two batch operationIds and generated tool input remain identical. Check emitted branches by kind and description, never only their count.

## Migration Plan

After core extraction, move definition ownership first, normalizers second, bindings third. Current-to-target map: `apps/be-01/src/controller/work-item.routes.ts` → core HTTP binder; `apps/be-01/src/service/plan-command.ts` → inferred type re-export in core; `apps/be-01/src/service/plan-commands.ts` → core runner. fe-01 imports wire types from contracts, never core. Keep compatibility exports while converting callers, then delete duplicate declarations in one final compile-checked slice. No migration or transport cutover.

## Risks / Trade-offs

The hand-written semantic parser contains defaults the structural schema intentionally omits; `setAssignee`'s missing personId becomes null, while create priority distinguishes absent/null/number. These are characterization cases, not cleanup opportunities. Exhaustive definitions derived from themselves need independent production-path command fixtures as their oracle.

## Open Questions

None for implementation. Generic inference and performance are unverified until the named tests run; their acceptance criteria are in tasks, not recorded as successful probes.
