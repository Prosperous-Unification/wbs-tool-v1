<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

Through mcp-01 an LLM edits a plan one request per field: 51 tools, and "estimate
these twelve rows" is thirty-six tool calls, each a model turn. It is too slow to
use. Every write path — the API, the MCP tools and the browser — should be one
shape: a list of commands applied together.

## What Changes

**One write endpoint**

- From: ~25 single-item write routes, each one command, one journal entry.
- To: `POST /api/projects/{id}/commands` takes an ordered list of typed commands
  (every plan write, every directory write), applies them all or none in one
  transaction, records one journal entry — one undo — and answers with the id
  each **ref** became. A refusal names the failing command's index and reason
  and leaves nothing applied. The single-item routes are removed.
- Impact: breaking for API callers other than fe-01 and mcp-01, which both move
  in this change. Undo of a single command is unchanged.

**mcp-01**

- From: 51 tools derived from the document.
- To: reads, `commands`, undo/redo and export — about 12 — still derived from
  the document with no hand-written schema.

**fe-01**

- From: one HTTP call per write method in `wbs-api.ts`.
- To: each write method posts a batch of one behind the same `ProjectApi` and
  `DirectoryApi` surface. Components, tests and undo labels are untouched.

## Non-Goals

No undo for directory entries (they run inside the batch's transaction, and the
spec says what undo leaves alone). No streaming or partial application. No
change to reads, to the WebSocket, to the journal depth or to the history
retention. No multi-connection be-01.

## Constraints

No schema change. The journal contract stands: one reversible batch is one
entry with a forward and an inverse, preconditions as today. `bun:sqlite`
transactions are synchronous and the stores are async — see the ADR.
`openapi.json` is regenerated; its freshness test gates mcp-01's tool set. The
browser gate must stay green with fe-01 on batches.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wbs-domain`: writes arrive as command batches; refs; the write lock; the
  MCP surface; the single-item routes retired.

## Domain Terms

Command batch; Ref; Write lock.

## Decisions Recorded

- [ADR 0007 — A command batch is an outer transaction over the stores' own](../../../docs/adr/0007-a-command-batch-is-an-outer-transaction-over-the-stores-own.md)

## Impact

`be-01` service/controller/compensating/openapi; `mcp-01` exclusions and tests;
`fe-01` `wbs-api.ts` and its fakes; `CONTEXT.md`; `docs/adr/0007`.
