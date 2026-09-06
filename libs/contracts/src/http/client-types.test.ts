import { type } from 'arktype';

import { clientFromShapes } from './client';
import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

const read = defineEndpointShape({
  method: 'GET',
  path: '/projects/:id',
  operationId: 'readProject',
  policies: [{ kind: 'identity', require: 'signed-in' }],
  query: requestSchema(type({ 'filter?': 'string' })),
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ project: { name: 'string' } })) },
  ],
  refusals: [
    { status: 429, schema: responseSchema(type({ error: "'rate_limited'" })) },
    {
      status: 501,
      schema: responseSchema(
        type({
          error: "'unsupported_body_version'",
          savedPlanId: 'string',
          body: "'input'",
          version: 'number',
          supported: 'number[]',
        }),
      ),
    },
  ],
  document: { summary: 'Read' },
});
const write = defineEndpointShape({
  method: 'POST',
  path: '/projects/:id',
  operationId: 'renameProject',
  policies: [],
  body: requestSchema(type({ name: 'string' })),
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [],
  document: { summary: 'Rename' },
});
const client = clientFromShapes([read, write], () =>
  Promise.resolve({ kind: 'empty', status: 204 }),
);

/** Compile-only fixtures use the actual generated methods and the gate's spec project. */
async function clientTypeFixtures(): Promise<void> {
  const missingOperation = 'deleteProject';
  // @ts-expect-error Only declared operation identifiers are methods.
  void client[missingOperation];
  // @ts-expect-error Path parameters are mandatory.
  await client.readProject({});
  // @ts-expect-error Parameter names come from the declared path.
  await client.readProject({ params: { projectId: 'p' } });
  // @ts-expect-error Unknown query fields are not part of this operation.
  await client.readProject({ params: { id: 'p' }, query: { extra: 'x' } });
  // @ts-expect-error The declared request body is required.
  await client.renameProject({ params: { id: 'p' } });
  // @ts-expect-error A renamed body field must fail at the real caller.
  await client.renameProject({ params: { id: 'p' }, body: { title: 'new' } });
  // @ts-expect-error Principals are resolved server-side, never supplied by clients.
  await client.readProject({ params: { id: 'p' }, principal: { id: 'caller' } });
  const readReply = await client.readProject({ params: { id: 'p' } });
  if (readReply.kind === 'success') {
    const name: string = readReply.body.project.name;
    void name;
    const missingField = 'title';
    // @ts-expect-error Only fields from the response schema are statically readable.
    void readReply.body.project[missingField];
  } else if (readReply.kind === 'refusal' && readReply.status === 501) {
    const versions: number[] = readReply.body.supported;
    void versions;
    // @ts-expect-error A 501 detail cannot widen into an unrelated refusal code.
    const code: 'rate_limited' = readReply.body.error;
    void code;
  } else if (readReply.kind === 'refusal') {
    // @ts-expect-error Detail belongs to its own status-specific refusal.
    void readReply.body.supported;
  }
  const wrongPair = {
    kind: 'refusal' as const,
    status: 429 as const,
    body: {
      error: 'unsupported_body_version' as const,
      savedPlanId: 's',
      body: 'input' as const,
      version: 2,
      supported: [1],
    },
    headers: new Headers(),
  };
  // @ts-expect-error The actual method's return type correlates each status and body.
  const checkedPair: Awaited<ReturnType<typeof client.readProject>> = wrongPair;
  void checkedPair;
  const written = await client.renameProject({ params: { id: 'p' }, body: { name: 'new' } });
  if (written.kind === 'success') {
    const status: 204 = written.status;
    void status;
    // @ts-expect-error An empty response has no JSON body.
    void written.body;
  }
}
void clientTypeFixtures;
