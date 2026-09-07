import { readFile } from 'node:fs/promises';

const DEFAULT_LIMIT = 20;
const ERROR_PREFIX = '::error ';
const NX_STREAM_BOLD_START = '\u001b[1m';
const NX_STREAM_COLOURS = [32, 92, 34, 94, 36, 96, 33, 93, 35, 95].map(
  (colour) => `\u001b[${String(colour)}m`,
);
const NX_STREAM_COLOUR_END = '\u001b[39m';
const NX_STREAM_BOLD_END = '\u001b[22m';

function containsCommandControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function nxStreamPrefixLength(line: string): number | null {
  const isBold = line.startsWith(NX_STREAM_BOLD_START);
  const colourStart = isBold ? NX_STREAM_BOLD_START.length : 0;
  const colour = NX_STREAM_COLOURS.find((candidate) => line.startsWith(candidate, colourStart));
  if (!colour) return null;
  const projectStart = colourStart + colour.length;
  const nxStreamEnd = `:${NX_STREAM_COLOUR_END}${isBold ? NX_STREAM_BOLD_END : ''} `;
  const projectEnd = line.indexOf(nxStreamEnd, projectStart);
  if (projectEnd === -1) return null;
  const project = line.slice(projectStart, projectEnd);
  // Proof: accepting a whitespace-bearing project token promoted the invalid
  // ANSI-prefix fixture into an annotation even though Nx cannot emit it.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project) ? projectEnd + nxStreamEnd.length : null;
}

function locatedErrorCommandOf(line: string): string | null {
  const nxPrefixLength = nxStreamPrefixLength(line);
  // Proof: accepting `indexOf(ERROR_PREFIX)` promoted the prose and plain-prefix
  // fixtures into annotations for files that did not fail.
  const command = line.startsWith(ERROR_PREFIX)
    ? line
    : nxPrefixLength !== null && line.startsWith(ERROR_PREFIX, nxPrefixLength)
      ? line.slice(nxPrefixLength)
      : null;
  // Proof: removing this guard made the direct C0/DEL selection case retain
  // the first 20 of 31 forbidden fixtures while CR splitting remained active.
  if (!command || containsCommandControl(command)) return null;

  const separator = command.indexOf('::', ERROR_PREFIX.length);
  if (separator === -1 || separator === command.length - 2) return null;

  const properties = new Map<string, string>();
  for (const field of command.slice(ERROR_PREFIX.length, separator).split(',')) {
    const equals = field.indexOf('=');
    // Proof: rejecting opaque comma continuations dropped the raw-comma case;
    // allowing later lookalike keys to overwrite the first location dropped
    // the `x=1, y=2, line=diagnostic text` case.
    if (equals <= 0) continue;
    const propertyName = field.slice(0, equals).trim();
    if (!properties.has(propertyName)) {
      properties.set(propertyName, field.slice(equals + 1).trim());
    }
  }

  return Boolean(properties.get('file')) && /^[1-9]\d*$/.test(properties.get('line') ?? '')
    ? command
    : null;
}

/** Selects exact GitHub error commands that can restore source annotations. */
export function selectErrorAnnotations(raw: string, limit = DEFAULT_LIMIT): string[] {
  // Proof: passing zero, a fraction, or an unsafe integer reaches this public
  // call path and the limit-contract test requires each to throw RangeError.
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`annotation limit must be a positive safe integer; got ${String(limit)}`);
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  // A bare CR is a line boundary too. Treating only CRLF/LF as boundaries let
  // an Actions command after CR remain inside a selected error command.
  for (const line of raw.split(/\r\n|\r|\n/)) {
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

/** Reads UTF-8 gate output and throws when the required log cannot be read. */
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
