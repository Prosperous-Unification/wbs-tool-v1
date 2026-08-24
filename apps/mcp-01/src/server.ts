import { existsSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpConfig } from './config';
import type { DerivedTool } from './openapi-tools';
import { OPENAPI_DOCUMENT_FILE } from './openapi-tools';
import type { FetchLike, ToolTextResult } from './wbs-client';
import { callTool } from './wbs-client';

/**
 * The three pieces composed: the tools section 2 derives, the call section 3
 * makes, and an MCP `Server` that hands one to the other. The choice of the
 * low-level `Server` over `McpServer`, and what it costs, is on `createServer`.
 */

/**
 * The version this server reports to its client. The monorepo's root
 * `package.json` is `0.0.0` and no app carries its own, but the protocol wants a
 * string, so this is mcp-01's own number and moves by hand.
 */
export const SERVER_VERSION = '0.1.0';

/**
 * D9, as a sentence a caller can act on.
 *
 * A write returns what be-01 returned, and be-01 returns the row it touched —
 * not the plan. Numbers, dates, floats and slices are recomputed from the tree
 * on every read, so one patch can move dates the response never mentions.
 */
const REREAD_AFTER_WRITE =
  'Numbers, dates, floats and slices are derived from the tree and re-derived on every read, so this result is not the new state of the plan — one write can move dates it does not mention. Re-read the project’s work items afterwards.';

/**
 * Does the operation's own prose already say numbers are derived and re-read?
 *
 * Four of be-01's write operations do (the hand-written bodies on `POST
 * /api/projects/{id}/work-items`, `PATCH /api/work-items/{id}`, `POST
 * /api/work-items/{id}/move` and `PUT …/progress/{roleId}`). Appending D9's
 * sentence to those would print the same warning twice in the same description,
 * in two different wordings — which reads as two different rules.
 */
const SAYS_IT_ALREADY = /re-?read|re-?derive|derived from the tree|recomput/i;

/**
 * The description a client sees: the document's prose, plus D9's warning on a
 * write that does not already carry one.
 *
 * Sourced rather than appended (task 4.3). Where be-01 says it, be-01's wording
 * wins — it is the API's own documentation, and mcp-01 paraphrasing it is how
 * the two drift.
 */
export function describeTool(tool: DerivedTool): string {
  if (tool.method === 'get') return tool.description;
  if (SAYS_IT_ALREADY.test(tool.description)) return tool.description;
  return `${tool.description}\n\n${REREAD_AFTER_WRITE}`;
}

/**
 * Where `openapi.json` is, from source *or* from a bundle.
 *
 * `openapi-tools.ts` reads the document at runtime rather than importing it —
 * `@nx/enforce-module-boundaries` stops `scope:app` reaching into another app's
 * tree — so the source-relative path is `apps/be-01/openapi.json` and resolves
 * only while running from source. `bun build` flattens everything to
 * `dist/apps/mcp-01/main.js`, where that path points at a directory that does
 * not exist, so the `build` target copies the document beside the bundle and
 * this looks there second.
 *
 * @throws naming both places it looked. An `ENOENT` from deep inside a read is
 * the same fault with none of the information.
 */
export function resolveDocumentFile(
  candidates: readonly string[] = [
    OPENAPI_DOCUMENT_FILE,
    new URL('./openapi.json', import.meta.url).pathname,
  ],
  exists: (file: string) => boolean = existsSync,
): string {
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new Error(
      `mcp-01 cannot find the OpenAPI document it derives its tools from. Looked at ${candidates.join(
        ' and ',
      )}. From source the first is apps/be-01/openapi.json; in a bundle the build target must copy it beside dist/apps/mcp-01/main.js.`,
    );
  }
  return found;
}

export interface ServerDeps {
  readonly tools: readonly DerivedTool[];
  readonly config: McpConfig;
  /** Injectable for the round trip in `server.test.ts`; production passes none. */
  readonly fetchImpl?: FetchLike;
  readonly callerTokenOf?: (authInfo: { readonly token: string } | undefined) => string;
}

const errorText = (message: string): ToolTextResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * A `ToolTextResult` as the SDK's `CallToolResult`.
 *
 * Ours is `readonly`, and the SDK's result type is a union with a task-shaped
 * member the compiler falls through to when the readonly one does not fit — the
 * error it prints is "property 'task' is missing", which is not the fault. One
 * copy, and the shape matches.
 */
const asCallToolResult = (
  result: ToolTextResult,
): { content: { type: 'text'; text: string }[]; isError?: true } => ({
  content: result.content.map((part) => ({ ...part })),
  ...(result.isError === undefined ? {} : { isError: result.isError }),
});

/**
 * An MCP server answering `tools/list` and `tools/call` for the derived tools.
 *
 * Not connected to a transport — `main.ts` does that, and the test connects it
 * to an in-memory pair instead.
 *
 * **`Server` is deprecated in 1.30.0 and used anyway**, which the two disable
 * comments below say at the point of use. The deprecation's own words are "Only
 * use `Server` for advanced use cases"; this is one. `McpServer.registerTool`
 * types `inputSchema` as `ZodRawShapeCompat | AnySchema` — checked against the
 * installed SDK, not remembered — so the high-level API would mean authoring all
 * 43 schemas a second time in zod beside the ones `openapi.json` already gives
 * us: two sources for one contract, and zod as a third validator in a repo that
 * has settled on typebox and arktype. See design.md D5.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- D5, see above.
export function createServer({ tools, config, fetchImpl, callerTokenOf }: ServerDeps): Server {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- D5, see above.
  const server = new Server(
    { name: 'mcp-01', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: describeTool(tool),
      // The schema the document produced, passed through (D5). Spread because
      // the SDK's type wants mutable properties and ours are `readonly`.
      inputSchema: { ...tool.inputSchema },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);

    // A name that is not a tool is not a failed call, it is a call that was
    // never made: a protocol error, so a client cannot read the reply as a
    // result. Returning empty content here would let a caller believe the
    // operation ran and returned nothing.
    if (tool === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `mcp-01 has no tool named "${request.params.name}". It serves ${String(
          byName.size,
        )} tools derived from be-01's OpenAPI document; call tools/list for the current set.`,
      );
    }

    try {
      return asCallToolResult(
        await callTool(
          tool,
          request.params.arguments ?? {},
          config,
          fetchImpl,
          callerTokenOf === undefined
            ? (() => {
                if (extra.authInfo === undefined)
                  throw new Error('authenticated caller is required');
                return extra.authInfo.token;
              })()
            : callerTokenOf(extra.authInfo),
        ),
      );
    } catch (cause) {
      // The opposite case, and deliberately not a throw. An undeclared input or
      // a missing path parameter is a mistake the caller can correct, and these
      // messages name what to correct — as tool content a model reads them and
      // tries again, as a protocol exception it mostly sees "the call failed".
      // be-01's own refusals already arrive this way (D7).
      return asCallToolResult(
        errorText(
          `${tool.name} could not be called: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  });

  return server;
}
