import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'bun:test';

import type { McpConfig } from './config';
import type { DerivedTool } from './openapi-tools';
import { readDocument, toolsFromDocument } from './openapi-tools';
import { createServer, describeTool, resolveDocumentFile, SERVER_VERSION } from './server';
import type { FetchLike } from './wbs-client';

const CONFIG: McpConfig = {
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
  WBS_TOKEN: 'token-abc',
  WBS_BASIC_AUTH: undefined,
};

const READ: DerivedTool = {
  name: 'getApiProjectsByIdWorkItems',
  description: 'Read a project’s work items',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  method: 'get',
  path: '/api/projects/{id}/work-items',
  locations: { id: 'path' },
};

const WRITE: DerivedTool = {
  name: 'patchApiWorkItemsById',
  description: 'Change a work item’s own fields',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  method: 'patch',
  path: '/api/work-items/{id}',
  locations: { id: 'path', name: 'body' },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** An in-process stand-in for be-01: records the request, answers with `payload`. */
const stub =
  (seen: Seen[], payload: string, status = 200): FetchLike =>
  (url, init) => {
    seen.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return Promise.resolve(
      new Response(payload, { status, headers: { 'content-type': 'application/json' } }),
    );
  };

/** A client and a server on a linked in-memory transport pair, already connected. */
async function connected(
  tools: readonly DerivedTool[],
  fetchImpl: FetchLike,
): Promise<{ client: Client }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ tools, config: CONFIG, fetchImpl });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client };
}

const failingFetch: FetchLike = () => {
  throw new Error('be-01 must not be called in this test');
};

describe('the round trip over MCP', () => {
  it('lists the derived tools, with their schemas, over the protocol', async () => {
    const { client } = await connected([READ, WRITE], failingFetch);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'getApiProjectsByIdWorkItems',
      'patchApiWorkItemsById',
    ]);
    // The schema the document produced, not a re-description of it.
    expect(listed.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('calls a read tool: the stub sees GET, the substituted path and the token', async () => {
    const seen: Seen[] = [];
    const { client } = await connected([READ, WRITE], stub(seen, '{"workItems":[]}'));

    const result = await client.callTool({
      name: 'getApiProjectsByIdWorkItems',
      arguments: { id: 'p-1' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('https://dev.wbs.bulletpoints.club/api/projects/p-1/work-items');
    expect(seen[0]?.headers['x-wbs-token']).toBe('token-abc');
    expect(seen[0]?.body).toBeUndefined();
    // be-01's body, passed through rather than re-serialised.
    expect(result.content).toEqual([{ type: 'text', text: '{"workItems":[]}' }]);
    expect(result.isError).toBeUndefined();
  });

  it('calls a write tool: the stub sees PATCH and the body properties, and not the path one', async () => {
    const seen: Seen[] = [];
    const { client } = await connected([READ, WRITE], stub(seen, '{"id":"w-1"}'));

    await client.callTool({
      name: 'patchApiWorkItemsById',
      arguments: { id: 'w-1', name: 'Renamed' },
    });

    expect(seen[0]?.method).toBe('PATCH');
    expect(seen[0]?.url).toBe('https://dev.wbs.bulletpoints.club/api/work-items/w-1');
    expect(seen[0]?.headers['x-wbs-token']).toBe('token-abc');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0]?.body ?? 'null')).toEqual({ name: 'Renamed' });
  });

  it('reports the server name and version it was built with', async () => {
    const { client } = await connected([READ], failingFetch);

    expect(client.getServerVersion()).toEqual({ name: 'mcp-01', version: SERVER_VERSION });
  });
});

describe('a name that is not a tool', () => {
  it('is a protocol error naming what to call instead, not an empty result', async () => {
    const { client } = await connected([READ, WRITE], failingFetch);

    // Rejects: a client cannot mistake this for a call that ran and returned
    // nothing. Caught rather than `rejects.toThrow`, whose bun typing is `void`
    // and which `await-thenable` therefore reads as an await of nothing.
    const cause: unknown = await client
      .callTool({ name: 'deleteEverything', arguments: {} })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(Error);
    expect(String(cause)).toContain('no tool named "deleteEverything"');
    expect(String(cause)).toContain('tools/list');
  });

  it('does not call be-01 at all', async () => {
    const seen: Seen[] = [];
    const { client } = await connected([READ], stub(seen, '{}'));

    const cause: unknown = await client
      .callTool({ name: 'nope', arguments: {} })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(Error);
    expect(seen).toHaveLength(0);
  });
});

describe('a call that cannot be built', () => {
  it('comes back as tool content the caller can correct, not a dropped connection', async () => {
    const seen: Seen[] = [];
    const { client } = await connected([READ], stub(seen, '{}'));

    const result = await client.callTool({
      name: 'getApiProjectsByIdWorkItems',
      arguments: { id: 'p-1', parentID: 'typo' },
    });

    expect(result.isError).toBe(true);
    // The message names the input and what the tool does declare, because that
    // is what the caller has to fix.
    expect(JSON.stringify(result.content)).toContain('parentID');
    expect(JSON.stringify(result.content)).toContain('getApiProjectsByIdWorkItems');
    // And the request was never made: an undeclared input is refused here, not
    // stripped by be-01 into a write that did something else.
    expect(seen).toHaveLength(0);
  });

  it('passes be-01’s own refusal code through as tool content', async () => {
    const seen: Seen[] = [];
    const { client } = await connected([WRITE], stub(seen, '{"error":"number_is_derived"}', 409));

    const result = await client.callTool({
      name: 'patchApiWorkItemsById',
      arguments: { id: 'w-1', name: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('number_is_derived');
  });
});

describe('describeTool', () => {
  it('leaves a read tool’s description exactly as the document wrote it', () => {
    expect(describeTool(READ)).toBe(READ.description);
  });

  it('adds D9’s re-read warning to a write the document says nothing about', () => {
    const described = describeTool(WRITE);

    expect(described.startsWith(WRITE.description)).toBe(true);
    expect(described).toContain('re-derived on every read');
  });

  it('does not add it twice where be-01 already says it', () => {
    const already: DerivedTool = {
      ...WRITE,
      description:
        'Add a work item to a project. Numbers are derived from the tree and re-derived on every read.',
    };

    expect(describeTool(already)).toBe(already.description);
  });
});

describe('the tools derived from the real document', () => {
  const tools = toolsFromDocument(readDocument(resolveDocumentFile()));

  it('every write tool tells the caller the result is not the new state', () => {
    const writes = tools.filter((tool) => tool.method !== 'get');
    const silent = writes.filter(
      (tool) => !/re-?read|re-?derive|derived from the tree|recomput/i.test(describeTool(tool)),
    );

    expect(writes.length).toBeGreaterThan(0);
    expect(silent.map((tool) => tool.name)).toEqual([]);
  });

  it('serves every one of them, and answers tools/list with the whole set', async () => {
    const { client } = await connected(tools, failingFetch);

    const listed = await client.listTools();

    expect(listed.tools).toHaveLength(tools.length);
    expect(listed.tools.every((tool) => (tool.description ?? '') !== '')).toBe(true);
  });
});

describe('resolveDocumentFile', () => {
  it('takes the source-relative path when the document is there', () => {
    expect(
      resolveDocumentFile(
        ['/a/openapi.json', '/b/openapi.json'],
        (file) => file === '/a/openapi.json',
      ),
    ).toBe('/a/openapi.json');
  });

  it('falls back to the copy beside the bundle', () => {
    expect(
      resolveDocumentFile(
        ['/a/openapi.json', '/b/openapi.json'],
        (file) => file === '/b/openapi.json',
      ),
    ).toBe('/b/openapi.json');
  });

  it('throws naming both places it looked, rather than an ENOENT from inside a read', () => {
    expect(() => resolveDocumentFile(['/a/openapi.json', '/b/openapi.json'], () => false)).toThrow(
      /\/a\/openapi\.json and \/b\/openapi\.json/,
    );
  });

  it('finds the committed document with its real defaults', () => {
    expect(resolveDocumentFile()).toMatch(/openapi\.json$/);
  });
});
