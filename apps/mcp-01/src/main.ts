import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config';
import { readDocument, toolsFromDocument } from './openapi-tools';
import { createServer, resolveDocumentFile } from './server';

/**
 * mcp-01's entrypoint: read the document, derive the tools, speak MCP on stdio.
 *
 * **stdout is the protocol.** A `console.log` here writes a line into the JSON-RPC
 * stream and the client drops the connection, so every message this process
 * prints goes to stderr — which the client shows as the server's log.
 */

const config = loadConfig();
const tools = toolsFromDocument(readDocument(resolveDocumentFile()));
const server = createServer({ tools, config });

await server.connect(new StdioServerTransport());

console.error(
  `mcp-01: ${String(tools.length)} tools derived from the OpenAPI document, serving ${config.WBS_API_URL} on stdio.`,
);
