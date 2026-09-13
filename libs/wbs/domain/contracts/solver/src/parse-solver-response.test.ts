import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { parseSolverResponse } from './parse-solver-response';

/**
 * 2.5 — every framing case is fed to `parseSolverResponse` **as a raw string**,
 * never through a child process. A process cannot reliably produce the
 * two-line and trailing-text cases on demand, and a test that cannot produce
 * its own input is a test that does not run.
 */

const VALID = readFileSync(
  new URL('../fixtures/response/valid-infeasible.json', import.meta.url),
  'utf8',
);
const oneLine = (source: string): string => `${JSON.stringify(JSON.parse(source))}\n`;
const VALID_LINE = oneLine(VALID);

describe('parseSolverResponse framing', () => {
  it('accepts exactly one JSON line with its terminator', () => {
    const parsed = parseSolverResponse(VALID_LINE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.response.status).toBe('infeasible');
  });

  it('accepts the same line without a terminator', () => {
    // The solver is a process, not a file: whether the last newline arrives is
    // not a property of the message.
    expect(parseSolverResponse(VALID_LINE.trimEnd()).ok).toBe(true);
  });

  it('rejects empty stdout', () => {
    for (const raw of ['', '\n', '   \n\t ']) {
      const parsed = parseSolverResponse(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.failure).toBe('empty-output');
    }
  });

  it('rejects two lines, even when both are valid', () => {
    const parsed = parseSolverResponse(VALID_LINE + VALID_LINE);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toBe('not-one-line');
  });

  it('rejects a warning printed before the answer', () => {
    // The realistic two-line case: the answer is present and correct, and the
    // process also said something. Concatenating stdout would still be one
    // JSON document to a lenient reader.
    const parsed = parseSolverResponse(`solver: worker limit clamped to 4\n${VALID_LINE}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toBe('not-one-line');
  });

  it('rejects trailing text after a valid line', () => {
    const parsed = parseSolverResponse(`${VALID_LINE}done`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toBe('not-one-line');
  });

  it('rejects trailing text on the same line as malformed JSON', () => {
    const parsed = parseSolverResponse(`${VALID_LINE.trimEnd()} done\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toBe('malformed-json');
  });

  it('rejects an unknown status', () => {
    const parsed = parseSolverResponse('{"wireVersion":1,"status":"optimal"}\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure).toBe('schema-violation');
      expect(parsed.detail).toContain('unknown status');
    }
  });

  it('rejects an unknown key', () => {
    const parsed = parseSolverResponse('{"wireVersion":1,"status":"infeasible","solveMs":12}\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure).toBe('schema-violation');
      expect(parsed.detail).toContain('unknown key solveMs');
    }
  });

  it('rejects a missing key', () => {
    const parsed = parseSolverResponse('{"wireVersion":1}\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure).toBe('schema-violation');
      expect(parsed.detail).toContain('unknown status');
    }
  });

  it('rejects a JSON value that is not an object', () => {
    for (const raw of ['null\n', '[]\n', '"feasible"\n', '7\n']) {
      const parsed = parseSolverResponse(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.failure).toBe('schema-violation');
    }
  });
});

/**
 * The corpus is the oracle. `violation()` is hand-written rather than driven by
 * a JSON Schema validator, so the thing that keeps it from drifting away from
 * `solver-wire.v1.json` is the manifest's own contract: a consumer that accepts
 * a message the schema rejects, or rejects one it accepts, fails here.
 */

interface ManifestEntry {
  readonly file: string;
  readonly branch: string;
  readonly valid: boolean;
  readonly why: string;
}

const manifest = JSON.parse(
  readFileSync(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'),
) as { readonly fixtures: readonly ManifestEntry[] };

const responseFixtures = manifest.fixtures.filter((entry) => entry.branch === 'response');

describe('parseSolverResponse agrees with the golden corpus', () => {
  it('enumerates the corpus rather than a hardcoded list', () => {
    // A corpus test that lost its subjects would otherwise pass silently.
    expect(responseFixtures.length).toBeGreaterThan(0);
  });

  for (const entry of responseFixtures) {
    it(`${entry.valid ? 'accepts' : 'rejects'} ${entry.file}`, () => {
      const source = readFileSync(new URL(`../fixtures/${entry.file}`, import.meta.url), 'utf8');
      const parsed = parseSolverResponse(oneLine(source));
      if (parsed.ok !== entry.valid) {
        throw new Error(
          `${entry.file}: schema says valid=${String(entry.valid)}, parser says ${String(parsed.ok)}` +
            (parsed.ok ? '' : ` (${parsed.failure}: ${parsed.detail})`) +
            `\n  why: ${entry.why}`,
        );
      }
    });
  }
});
