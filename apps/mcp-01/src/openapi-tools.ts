import { readFileSync } from 'node:fs';

/**
 * Tools are derived from `apps/be-01/openapi.json`, never hand-listed.
 *
 * The document is committed and drift-checked against the running app by
 * `apps/be-01/src/openapi/openapi-document.test.ts`, so deriving from it means
 * be-01's routes and mcp-01's tools cannot disagree without a red test. See
 * design.md D4; the exclusions are D1 and the schema honesty is D8.
 *
 * Everything here refuses rather than guesses (R5). An operation with no
 * `operationId`, a body that is not JSON, a parameter in a place this server
 * cannot send, a name claimed twice, an exclusion that no longer matches
 * anything — each throws and names what it saw. A tool list that quietly
 * narrows is the failure this module exists to prevent, and a narrowing is
 * invisible unless something is watching for it.
 */

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Where a named input travels when the call is made. Section 3 reads this. */
export type InputLocation = 'path' | 'query' | 'body';

/** Plain JSON Schema, which is what the low-level MCP `Server` wants (D5). */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface DerivedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly method: HttpMethod;
  readonly path: string;
  readonly locations: Readonly<Record<string, InputLocation>>;
}

/**
 * The document as read off disk — every value optional, because it is parsed
 * JSON and this repo does not run `noUncheckedIndexedAccess`. Typing the holes
 * in is what lets the checks below be real checks rather than dead branches
 * lint would strip.
 */
interface OpenApiParameter {
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: unknown;
}

interface OpenApiBodySchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly description?: string;
    readonly content?: Readonly<
      Record<string, { readonly schema?: OpenApiBodySchema } | undefined>
    >;
  };
}

type OpenApiPathItem = Readonly<Record<string, OpenApiOperation | undefined>>;

export interface OpenApiDocument {
  readonly paths?: Readonly<Record<string, OpenApiPathItem | undefined>>;
}

/**
 * D1's three exclusion classes, as one named set.
 *
 * `/api/auth/*` would make this a credential factory; `/internal/*` is gw-01's
 * surface behind a different secret; the last three carry no plan. A trailing
 * `/*` matches a prefix and nothing else does — no regex, because a pattern
 * that can match more than it reads is the wrong tool for a deny list.
 */
export const EXCLUDED_PATHS = [
  '/api/auth/*',
  '/internal/*',
  '/health',
  '/metrics',
  '/api/smoke/echo',
] as const;

/** What the MCP protocol accepts as a tool name; `operationId` must already fit. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

const excludes = (pattern: string, path: string): boolean =>
  pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

const isMethod = (key: string): key is HttpMethod =>
  (HTTP_METHODS as readonly string[]).includes(key);

const joinProse = (...parts: (string | undefined)[]): string =>
  parts
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n\n');

/**
 * One operation → one tool.
 *
 * @throws if the operation cannot become a tool without inventing something the
 * document does not say.
 */
function toTool(method: HttpMethod, path: string, operation: OpenApiOperation): DerivedTool {
  const where = `${method.toUpperCase()} ${path}`;
  const name = operation.operationId;

  // Synthesising a name from the path would work, right up until two paths
  // collapse to the same name and one tool silently shadowed the other.
  if (name === undefined || name.trim() === '') {
    throw new Error(
      `${where} has no operationId, so no tool name can be derived. Give the route an operationId in be-01 and regenerate apps/be-01/openapi.json.`,
    );
  }
  if (!TOOL_NAME.test(name)) {
    throw new Error(
      `${where} has operationId "${name}", which is not a usable MCP tool name (letters, digits, "_" and "-", 1-128 characters).`,
    );
  }

  const properties = new Map<string, unknown>();
  const locations = new Map<string, InputLocation>();
  const required: string[] = [];

  const claim = (property: string, schema: unknown, location: InputLocation): void => {
    const taken = locations.get(property);
    if (taken !== undefined) {
      throw new Error(
        `${name}: "${property}" is declared as both a ${taken} input and a ${location} input. One would overwrite the other, so neither is sent.`,
      );
    }
    locations.set(property, location);
    properties.set(property, schema ?? {});
  };

  for (const parameter of operation.parameters ?? []) {
    const parameterName = parameter.name;
    if (parameterName === undefined || parameterName === '') {
      throw new Error(`${where} declares a parameter with no name.`);
    }
    // Header and cookie parameters would need mcp-01 to decide what to put in
    // them; it holds one token and no other credential, so it refuses instead.
    if (parameter.in !== 'path' && parameter.in !== 'query') {
      throw new Error(
        `${where} declares parameter "${parameterName}" in "${parameter.in ?? 'nowhere'}", which mcp-01 cannot send. Only path and query parameters become tool inputs.`,
      );
    }
    claim(parameterName, parameter.schema, parameter.in);
    // A path parameter is required whether or not the document says so: the URL
    // cannot be built without it.
    if (parameter.required === true || parameter.in === 'path') required.push(parameterName);
  }

  const body = operation.requestBody;
  if (body !== undefined) {
    const schema = body.content?.['application/json']?.schema;
    if (schema?.type !== 'object') {
      throw new Error(
        `${where} carries a request body with no application/json object schema, so its inputs cannot be derived.`,
      );
    }
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      claim(property, propertySchema, 'body');
    }
    for (const property of schema.required ?? []) {
      if (locations.get(property) !== 'body') {
        throw new Error(
          `${where} lists "${property}" as required in its body but does not declare it as a body property.`,
        );
      }
      required.push(property);
    }
  }

  // 40 of be-01's 51 operations carry no prose at all — the typebox routes
  // generate their document entry. Saying so is honest; writing a summary here
  // would be this file inventing API documentation.
  const written = joinProse(operation.summary, operation.description);
  const headline =
    written === ''
      ? `${where} — the committed OpenAPI document carries no prose for this operation.`
      : written;

  return {
    name,
    // D8: eight bodies are documentation, not validation, and each says so in
    // its own description. Passed through unedited so the caller reads the
    // caveat rather than mcp-01's paraphrase of it.
    description: joinProse(
      headline,
      body?.description === undefined ? undefined : `Request body: ${body.description}`,
    ),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(properties),
      ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
      // mcp-01 refuses to forward an input the operation does not declare (task
      // 3.1), so the schema says the same thing rather than advertising a
      // permissiveness the caller would then hit a throw on.
      additionalProperties: false,
    },
    method,
    path,
    locations: Object.fromEntries(locations),
  };
}

/**
 * Every operation in the document that is not excluded, as a tool.
 *
 * @throws if an entry in {@link EXCLUDED_PATHS} matches nothing in the
 * document. An exclusion that has stopped matching is a route that has moved,
 * and the failure it hides — the list excluding less than it reads, a renamed
 * `/internal/*` reappearing as a callable tool — is silent everywhere else.
 */
export function toolsFromDocument(document: OpenApiDocument): DerivedTool[] {
  const paths = document.paths;
  if (paths === undefined || Object.keys(paths).length === 0) {
    throw new Error('the OpenAPI document has no paths, so no tools can be derived from it.');
  }

  const matched = new Set<string>();
  const tools: DerivedTool[] = [];
  const seen = new Map<string, string>();

  for (const [path, item] of Object.entries(paths)) {
    const pattern = EXCLUDED_PATHS.find((candidate) => excludes(candidate, path));
    if (pattern !== undefined) {
      matched.add(pattern);
      continue;
    }
    if (item === undefined) continue;
    for (const [key, operation] of Object.entries(item)) {
      if (!isMethod(key) || operation === undefined) continue;
      const tool = toTool(key, path, operation);
      const first = seen.get(tool.name);
      if (first !== undefined) {
        throw new Error(
          `operationId "${tool.name}" is used by both ${first} and ${key.toUpperCase()} ${path}; one tool would shadow the other.`,
        );
      }
      seen.set(tool.name, `${key.toUpperCase()} ${path}`);
      tools.push(tool);
    }
  }

  const stale = EXCLUDED_PATHS.filter((pattern) => !matched.has(pattern));
  if (stale.length > 0) {
    throw new Error(
      `the exclusion list names ${stale.map((pattern) => `"${pattern}"`).join(', ')}, which the document no longer contains. A route that moved must be re-excluded under its new path, or dropped from the list deliberately — see design.md D1.`,
    );
  }

  return tools;
}

/**
 * Where the committed document lives, relative to this source file.
 *
 * Read at runtime rather than imported: `@nx/enforce-module-boundaries` stops
 * `scope:app` reaching into another app's tree, and it is right to. The built
 * bundle needs this file beside it — task 4.1 owns that, and until then the
 * path only resolves when running from source.
 */
export const OPENAPI_DOCUMENT_FILE = new URL('../../be-01/openapi.json', import.meta.url).pathname;

/** @throws if the document is missing or is not JSON, naming the path either way. */
export function readDocument(file: string = OPENAPI_DOCUMENT_FILE): OpenApiDocument {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read the OpenAPI document at ${file}`, { cause });
  }
  try {
    return JSON.parse(text) as OpenApiDocument;
  } catch (cause) {
    throw new Error(`the OpenAPI document at ${file} is not valid JSON`, { cause });
  }
}
