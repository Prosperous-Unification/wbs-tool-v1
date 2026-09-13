import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

const HERE = new URL('./', import.meta.url);
const README = new URL('../README.md', import.meta.url);
const ADRS = new URL('../../../docs/adr/', import.meta.url);

/**
 * The README's noun → module map names files and ADRs that exist.
 *
 * A README is the one artefact nothing else checks, so it rots first: a module
 * renamed leaves the table pointing at nothing, and a reader following it
 * concludes the rule is gone. The map is this library's public shape — "which
 * file decides this question" — so it is worth an assertion rather than a
 * convention.
 *
 * Only what the table **claims** is checked, deliberately: a module absent from
 * it is not a failure (`index.ts` and the test files are not nouns), and the
 * one row that names no file at all is the point of that row — a work item type
 * does not inherit, so nothing decides it (ADR 0009).
 *
 * Proof: `is-within.ts` renamed in the table to `within.ts`, watched failing on
 * `expect(received).toBeEmpty() · Received: [ "within.ts" ]`; and ADR 0011
 * cited as ADR 0014, on `[ "0014" ]`. Observed 2026-09-02.
 */
describe('the README', () => {
  it('names modules that exist', async () => {
    const text = await readFile(README, 'utf8');
    const named = [...text.matchAll(/`([a-z-]+\.ts)`/g)].map((match) => match[1]);
    const onDisk = new Set(await readdir(HERE));

    expect(named.filter((file) => !onDisk.has(file))).toBeEmpty();
    // The precondition: a table that named nothing would pass the line above.
    expect(new Set(named).size).toBeGreaterThan(10);
  });

  it('cites ADRs that exist', async () => {
    const text = await readFile(README, 'utf8');
    const cited = [...text.matchAll(/ADR (\d{4})/g)].map((match) => match[1]);
    const numbers = new Set((await readdir(ADRS)).map((file) => file.slice(0, 4)));

    expect(cited.filter((number) => !numbers.has(number))).toBeEmpty();
    expect(new Set(cited).size).toBeGreaterThan(2);
  });
});
