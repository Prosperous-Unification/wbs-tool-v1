import type { JsonSchema } from 'arktype';

import { bodyMediaFor, type EndpointShape } from './endpoint-shape';
import { assertInlineSchema } from './schema-shape';

export interface DocumentParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export interface DocumentResponse {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
}

export interface DocumentOperation {
  operationId: string;
  summary: string;
  parameters: DocumentParameter[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, DocumentResponse | undefined>;
}

export interface ShapeDocument {
  openapi: '3.1.0';
  info: { title: string; version: string };
  paths: Record<string, Record<string, DocumentOperation | undefined> | undefined>;
}

/**
 * Emits only generated descriptors; validators are never inspected or invoked.
 * Bodies stay inline so MCP can derive individual named inputs, including unions
 * nested under an object property. The mounted adapter's reachability checks
 * separately establish that every documented operation is actually served.
 * @throws for references, ambiguous operation names/routes or non-object parameters.
 */
export function documentFromShapes(shapes: readonly EndpointShape[]): ShapeDocument {
  const paths: ShapeDocument['paths'] = {};
  const names = new Set<string>();
  for (const shape of shapes) {
    const bodyMedia = bodyMediaFor(shape);
    const bodySchema = shape.body?.jsonSchema;
    // Proof: bypassing these descriptor checks published a tool with unresolved
    // tree references instead of throwing in MCP's structural-descriptor test
    // (shape-document.test.ts), independently of declaration-time validation.
    for (const schema of [shape.params, shape.query, shape.body]) {
      if (schema !== undefined) assertInlineSchema(schema.jsonSchema);
    }
    for (const response of shape.responses) {
      if (response.kind === 'json') assertInlineSchema(response.schema.jsonSchema);
    }
    for (const refusal of shape.refusals) assertInlineSchema(refusal.schema.jsonSchema);
    // Proof: removing blank-name or duplicate-name refusal made the named emitter
    // tests return documents instead of throwing (document-from-shapes.test.ts).
    if (shape.operationId.trim() === '' || names.has(shape.operationId)) {
      throw new Error(`missing or duplicate operationId: ${shape.operationId}`);
    }
    names.add(shape.operationId);
    const path = shape.path.replace(/:([^/]+)/g, '{$1}');
    const method = shape.method.toLowerCase();
    const operations = paths[path] ?? {};
    // Proof: omitting this guard silently replaced the converted-path operation
    // in the colliding-method test (document-from-shapes.test.ts).
    if (operations[method] !== undefined) throw new Error(`duplicate route: ${method} ${path}`);
    const parameters: DocumentParameter[] = [];
    const declaredParams =
      shape.params === undefined ? undefined : objectSchema(shape.params.jsonSchema);
    for (const segment of shape.path.split('/')) {
      if (!segment.startsWith(':')) continue;
      const name = segment.slice(1);
      const schema = declaredParams?.properties?.[name];
      // Proof: omitting this guard emitted a fallback string for an undeclared
      // route parameter rather than throwing in the missing-descriptor test.
      if (declaredParams !== undefined && schema === undefined) {
        throw new Error(`missing path parameter descriptor: ${name}`);
      }
      parameters.push({ name, in: 'path', required: true, schema: schema ?? { type: 'string' } });
    }
    if (shape.query !== undefined) {
      const query = objectSchema(shape.query.jsonSchema);
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        parameters.push({
          name,
          in: 'query',
          required: query.required?.includes(name) === true,
          schema,
        });
      }
    }
    const responses: DocumentOperation['responses'] = {};
    for (const response of shape.responses) {
      const content =
        response.kind === 'empty'
          ? undefined
          : response.kind === 'text'
            ? { [response.contentType]: { schema: { type: 'string' } satisfies JsonSchema } }
            : { 'application/json': { schema: response.schema.jsonSchema } };
      addResponse(responses, response.status, {
        description: 'Success',
        ...(content === undefined ? {} : { content }),
      });
    }
    for (const refusal of shape.refusals) {
      addResponse(responses, refusal.status, {
        description: 'Refusal',
        content: { 'application/json': { schema: refusal.schema.jsonSchema } },
      });
    }
    // Proof: removing operationId made the actual MCP consumer reject the emitted
    // document; dropping label or one commands union arm failed its input assertions
    // (apps/mcp-01/src/shape-document.test.ts).
    operations[method] = {
      operationId: shape.operationId,
      summary: shape.document.summary,
      parameters,
      responses,
      ...(bodySchema === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              // Proof: emitting only JSON failed the accepted-media keys assertion in document-from-shapes.test.ts.
              content: Object.fromEntries(
                bodyMedia.map((media) => [media, { schema: bodySchema }]),
              ),
            },
          }),
    };
    paths[path] = operations;
  }
  return { openapi: '3.1.0', info: { title: 'WBS API', version: '1.0.0' }, paths };
}

/** Parameters require named properties; a union cannot be flattened without losing constraints. */
function objectSchema(schema: JsonSchema): JsonSchema.Object {
  // Proof: removing this check silently erased scalar/array query inputs instead
  // of refusing them (document-from-shapes.test.ts).
  if (!('type' in schema) || schema.type !== 'object')
    throw new Error('parameter schema must be an inline object');
  // Generated JSON Schema is discriminated by type at this descriptor boundary.
  const object = schema as JsonSchema.Object;
  const parameterKeywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    '$schema',
    'title',
    'description',
  ]);
  // Proof: removing this constraint check admits an indexed query in
  // document-from-shapes.test.ts instead of throwing the named refusal.
  if (
    object.additionalProperties !== false ||
    Object.keys(object).some((key) => !parameterKeywords.has(key))
  ) {
    throw new Error('cannot flatten parameter schema without losing object constraints');
  }
  return object;
}

/** Multiple bodies at one status remain alternatives rather than overwriting one another. */
function addResponse(
  responses: DocumentOperation['responses'],
  status: number,
  response: DocumentResponse,
): void {
  const key = String(status);
  const previous = responses[key];
  if (previous === undefined) {
    responses[key] = response;
    return;
  }
  // Proof: removing this diagnostic replaced the named ambiguous-status error
  // with Object.entries on undefined in the repeated-empty-status test.
  if (previous.content === undefined || response.content === undefined)
    throw new Error(`ambiguous empty response at ${key}`);
  for (const [mediaType, representation] of Object.entries(response.content)) {
    const earlier = previous.content[mediaType];
    // Proof: overwriting instead of combining retained only the third response
    // arm in the response-alternatives test (document-from-shapes.test.ts).
    previous.content[mediaType] = Object.hasOwn(previous.content, mediaType)
      ? { schema: { anyOf: [earlier.schema, representation.schema] } }
      : representation;
  }
}
