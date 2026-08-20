import { describe, expect, it } from 'bun:test';

import type { McpConfig } from './config';
import type { DerivedTool } from './openapi-tools';
import type { FetchLike } from './wbs-client';
import { buildRequest, callTool } from './wbs-client';

const CONFIG: McpConfig = {
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
  WBS_TOKEN: 'token-abc',
  WBS_BASIC_AUTH: undefined,
};

/** A read: two path parameters and one query parameter, no body. */
const READ: DerivedTool = {
  name: 'getApiProjectsByIdWorkItems',
  description: 'irrelevant here',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  method: 'get',
  path: '/api/projects/{id}/work-items',
  locations: { id: 'path', includeClosed: 'query' },
};

/** A write: one path parameter and two body properties. */
const WRITE: DerivedTool = {
  name: 'patchApiWorkItemsById',
  description: 'irrelevant here',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  method: 'patch',
  path: '/api/work-items/{id}',
  locations: { id: 'path', name: 'body', estimate: 'body' },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A stub be-01 that records what it was asked and answers what it was told to. */
const stub = (response: Response): { fetch: FetchLike; calls: Seen[] } => {
  const calls: Seen[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return Promise.resolve(response);
    },
  };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const textOf = (result: { content: readonly { text: string }[] }): string =>
  result.content.map((part) => part.text).join('\n');

/**
 * The message a promise rejected with, or a marker when it resolved. Written
 * out rather than `.rejects.toThrow`, which returns void here and so cannot be
 * awaited — an unawaited assertion passes whatever happens, which is exactly
 * the failure these two tests exist to rule out. Same helper as
 * `apps/be-01/src/repository/project.test.ts`.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(resolved without throwing)';
  } catch (error) {
    return String(error);
  }
}

describe('buildRequest', () => {
  it('substitutes path parameters and puts the rest in the query string', () => {
    const request = buildRequest(READ, { id: 'p1', includeClosed: true }, CONFIG);
    expect(request.method).toBe('GET');
    expect(request.url).toBe(
      'https://dev.wbs.bulletpoints.club/api/projects/p1/work-items?includeClosed=true',
    );
    expect(request.body).toBeUndefined();
  });

  it('splits path from body for a write, and sends only what was given', () => {
    const request = buildRequest(WRITE, { id: 'w1', name: 'Rewire' }, CONFIG);
    expect(request.url).toBe('https://dev.wbs.bulletpoints.club/api/work-items/w1');
    expect(request.method).toBe('PATCH');
    expect(JSON.parse(request.body ?? '')).toEqual({ name: 'Rewire' });
    expect(request.headers['content-type']).toBe('application/json');
  });

  it('sends the account token on every request', () => {
    expect(buildRequest(READ, { id: 'p1' }, CONFIG).headers['x-wbs-token']).toBe('token-abc');
  });

  it('adds a basic-auth header only when WBS_BASIC_AUTH is set', () => {
    expect(buildRequest(READ, { id: 'p1' }, CONFIG).headers['authorization']).toBeUndefined();
    const gated = buildRequest(READ, { id: 'p1' }, { ...CONFIG, WBS_BASIC_AUTH: 'dany:hunter2' });
    expect(gated.headers['authorization']).toBe(
      `Basic ${Buffer.from('dany:hunter2', 'utf8').toString('base64')}`,
    );
    // The gate credential must not displace the account one.
    expect(gated.headers['x-wbs-token']).toBe('token-abc');
  });

  it('escapes a path parameter rather than letting it change the path', () => {
    expect(buildRequest(READ, { id: 'a/b' }, CONFIG).url).toContain('/api/projects/a%2Fb/');
  });

  it('treats an explicit undefined as an omitted input, but sends null', () => {
    const request = buildRequest(WRITE, { id: 'w1', name: null, estimate: undefined }, CONFIG);
    expect(JSON.parse(request.body ?? '')).toEqual({ name: null });
  });

  // Watched red for task 3.1. Delete the `location === undefined` throw and
  // forward the input instead — be-01 strips it before the handler runs, so the
  // write reports success having done something else.
  it('throws on an input the operation does not declare, and lists the ones it does', () => {
    expect(() => buildRequest(WRITE, { id: 'w1', parentID: 'w0' }, CONFIG)).toThrow(
      /does not declare an input named "parentID".*id, name, estimate/s,
    );
  });

  it('throws when a path parameter is missing rather than leaving a literal in the URL', () => {
    expect(() => buildRequest(WRITE, { name: 'Rewire' }, CONFIG)).toThrow(
      /needs the path parameter "id"/,
    );
  });

  it('throws on a non-scalar query value rather than flattening it', () => {
    expect(() => buildRequest(READ, { id: 'p1', includeClosed: { deep: 1 } }, CONFIG)).toThrow(
      /query parameter "includeClosed" must be a string, number or boolean/,
    );
  });

  it('does not send a body for an operation that declares none', () => {
    expect(buildRequest(READ, { id: 'p1' }, CONFIG).headers['content-type']).toBeUndefined();
  });
});

describe('callTool', () => {
  it('returns be-01’s JSON body unedited on success', async () => {
    const be01 = stub(json(200, { items: [{ id: 'w1', number: '1.1' }] }));
    const result = await callTool(READ, { id: 'p1' }, CONFIG, be01.fetch);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ items: [{ id: 'w1', number: '1.1' }] });
    expect(be01.calls[0]?.headers['x-wbs-token']).toBe('token-abc');
    expect(be01.calls[0]?.method).toBe('GET');
  });

  it('reports a 204 as no content rather than as a parse failure', async () => {
    const be01 = stub(new Response(null, { status: 204 }));
    const result = await callTool(WRITE, { id: 'w1' }, CONFIG, be01.fetch);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('204');
  });

  // Watched red for D7 / task 3.2. Replace the passthrough with a generic
  // "request failed" and this goes red: the code is the only thing an agent can
  // correct itself with.
  it('carries be-01’s refusal code verbatim, with the status', async () => {
    const be01 = stub(json(400, { error: 'number_is_derived' }));
    const result = await callTool(WRITE, { id: 'w1', name: '2.3' }, CONFIG, be01.fetch);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('number_is_derived');
    expect(textOf(result)).toContain('400');
  });

  it('keeps the rest of a refusal body, not only the code', async () => {
    const be01 = stub(json(409, { error: 'in_use', usage: { workItems: 3 } }));
    const result = await callTool(WRITE, { id: 'w1' }, CONFIG, be01.fetch);
    expect(textOf(result)).toContain('in_use');
    expect(textOf(result)).toContain('workItems');
  });

  // Watched red for D6 / task 3.3. A 401 must not read like a 400: the caller
  // cannot fix an expired token by sending different inputs. Drop the 401
  // branch and this goes red.
  it('names the expired token and the restart on a 401 from be-01', async () => {
    const be01 = stub(json(401, { error: 'unauthorized' }));
    const result = await callTool(READ, { id: 'p1' }, CONFIG, be01.fetch);
    expect(result.isError).toBe(true);
    const message = textOf(result);
    expect(message).toMatch(/WBS_TOKEN/);
    expect(message).toMatch(/expired or invalid/);
    expect(message).toMatch(/restart/i);
    expect(message).toContain('unauthorized');
  });

  // The other 401. fe-01 shipped this bug once already: an edge challenge
  // reported as `http_401` sent someone hunting through the app for a fault one
  // layer above it. Delete the `www-authenticate` check and this goes red.
  it('separates the deployment gate’s 401 from be-01’s own', async () => {
    const be01 = stub(
      new Response('<html>401 Unauthorized</html>', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="wbs-dev"' },
      }),
    );
    const message = textOf(await callTool(READ, { id: 'p1' }, CONFIG, be01.fetch));
    expect(message).toContain('WBS_BASIC_AUTH');
    expect(message).toMatch(/never reached the API/);
    expect(message).not.toContain('WBS_TOKEN');
  });

  it('keeps the status when a refusal body is not JSON', async () => {
    const be01 = stub(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const result = await callTool(READ, { id: 'p1' }, CONFIG, be01.fetch);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('502');
  });

  // Watched red for task 3.4. Coerce the parse failure to `{}` and this goes
  // red — an empty object reported as the plan is a plan with nothing in it.
  it('throws when a 2xx body is not JSON rather than coercing it', async () => {
    const be01 = stub(new Response('<html>hello from a proxy</html>', { status: 200 }));
    expect(await rejection(callTool(READ, { id: 'p1' }, CONFIG, be01.fetch))).toMatch(
      /body that is not JSON/,
    );
  });

  it('does not call be-01 at all when the request cannot be built', async () => {
    const be01 = stub(json(200, {}));
    expect(await rejection(callTool(WRITE, { nope: 1 }, CONFIG, be01.fetch))).toMatch(
      /does not declare an input named "nope"/,
    );
    expect(be01.calls).toHaveLength(0);
  });
});
