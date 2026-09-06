import { readFile } from 'node:fs/promises';

const DEFAULT_LIMIT = 20;
const ERROR_PREFIX = '::error ';

function locatedErrorCommandOf(line: string): string | null {
  // Proof: requiring `startsWith(ERROR_PREFIX)` made the ANSI-prefixed Nx
  // fixture receive `[]` instead of its exact located command.
  const commandStart = line.indexOf(ERROR_PREFIX);
  if (commandStart === -1) return null;

  const command = line.slice(commandStart);
  const separator = command.indexOf('::', ERROR_PREFIX.length);
  if (separator === -1 || separator === command.length - 2) return null;

  const properties = new Map<string, string>();
  for (const field of command.slice(ERROR_PREFIX.length, separator).split(',')) {
    const equals = field.indexOf('=');
    if (equals <= 0) return null;
    properties.set(field.slice(0, equals).trim(), field.slice(equals + 1).trim());
  }

  return Boolean(properties.get('file')) && /^[1-9]\d*$/.test(properties.get('line') ?? '')
    ? command
    : null;
}

/** Selects exact GitHub error commands that can restore source annotations. */
export function selectErrorAnnotations(raw: string, limit = DEFAULT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`annotation limit must be a positive safe integer; got ${String(limit)}`);
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const command = locatedErrorCommandOf(line);
    // Proof: deleting `seen.has(command)` made the twenty-command test receive
    // case-0 twice and drop case-19, failing with one unexpected entry.
    if (!command || seen.has(command)) continue;
    // Proof: stripping `,col=9` here made the exact-command test receive the
    // right file and line but the wrong command, and it failed at its equality.
    selected.push(command);
    seen.add(command);
    // Proof: deleting this break made the bound test receive case-20 as a
    // twenty-first command (`Expected -0 / Received +1`).
    if (selected.length === limit) break;
  }
  return selected;
}

export async function readErrorAnnotations(path: string): Promise<string[]> {
  return selectErrorAnnotations(await readFile(path, 'utf8'));
}

async function main(): Promise<void> {
  const [path, unexpected] = process.argv.slice(2);
  if (!path || unexpected) {
    throw new Error('usage: bun run ci-gate-annotations.ts <nx-gate.log>');
  }

  const annotations = await readErrorAnnotations(path);
  if (annotations.length > 0) process.stdout.write(`${annotations.join('\n')}\n`);
}

if (import.meta.main) await main();
