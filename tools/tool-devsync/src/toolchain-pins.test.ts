import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'bun:test';

/**
 * The version pins that can drift apart, held together by a test.
 *
 * Bun's version used to be typed in six places — the CI workflow twice, three
 * app Dockerfiles and the dev-src Dockerfile — and on 2026-09-06 they said
 * three different things: 1.3.14, 1.3.14 and 1.2.20, against a 1.4.0 on the
 * workspace box. Nothing read them side by side, so nothing could say so.
 * `.bun-version` is now the one source: `setup-bun` reads it through
 * `bun-version-file`, and the Dockerfiles, which cannot read a file, are held
 * to it here.
 *
 * Every file this suite reads from outside its own project is named in
 * `tool-devsync:test`'s `inputs`, and that is not bookkeeping: Nx caches the
 * target, and a read it does not know about is a change it cannot see.
 * Measured 2026-09-06: with `{workspaceRoot}/apps/*\/Dockerfile` declared, a
 * Dockerfile put back to 1.3.14 re-ran this suite and failed it; with that
 * line removed, the same edit answered `nx run tool-devsync:test [local
 * cache]` — green, having run nothing. `workspace-targets.test.ts` cannot see
 * these reads (it looks for `'../../../…'` literals), so the list is kept by hand.
 *
 * Proof: with `apps/be-01/Dockerfile`'s first stage put back to
 * `oven/bun:1.3.14-alpine`, `every Bun image tag equals .bun-version` failed
 * on `- []` / `+ [ "apps/be-01/Dockerfile: 1.3.14" ]` (2026-09-06). And with
 * `bun-version: 1.3.14` put back in place of `bun-version-file` in the
 * `pixels` job, `CI reads the file rather than a literal` failed on
 * `Expected: 0 · Received: 1`.
 */
const WORKSPACE = new URL('../../../', import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, WORKSPACE), 'utf8');
}

/** Every Dockerfile that starts from a Bun image. Listed, so a new one is added here on the day it is written. */
const BUN_DOCKERFILES = [
  'apps/be-01/Dockerfile',
  'apps/gw-01/Dockerfile',
  'apps/fe-01/Dockerfile',
  'deploy/dev-src/Dockerfile',
] as const;

describe('the Bun version', () => {
  it('has one source, and it is a bare version', async () => {
    const pinned = (await read('.bun-version')).trim();
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('every Bun image tag equals .bun-version', async () => {
    const pinned = (await read('.bun-version')).trim();
    const drifted: string[] = [];
    for (const file of BUN_DOCKERFILES) {
      // The version alone: `1.4.2-alpine AS deps` and `1.4.2-debian` are both one pin.
      const tags = [...(await read(file)).matchAll(/^FROM oven\/bun:(\d+\.\d+\.\d+)/gm)].map(
        (m) => m[1],
      );
      // A Dockerfile with no Bun stage is a listing error, not a pass.
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) if (tag !== pinned) drifted.push(`${file}: ${tag}`);
    }
    expect(drifted).toEqual([]);
  });

  it('CI reads the file rather than a literal', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    const literals = workflow.match(/^\s*bun-version:/gm) ?? [];
    expect(literals.length).toBe(0);
    const fromFile = workflow.match(/^\s*bun-version-file: \.bun-version$/gm) ?? [];
    // Both jobs set Bun up; one reading the file and one floating is the drift this exists to stop.
    expect(fromFile.length).toBe((workflow.match(/uses: oven-sh\/setup-bun@/g) ?? []).length);
  });
});

/**
 * TypeScript wears two hats here, and each is pinned to its own major.
 *
 * `tsc` on the workspace path is TypeScript 7 — the native compiler, ten
 * times faster and the one every `typecheck` target runs. TypeScript 7 ships
 * no compiler API, and typescript-eslint needs one (`>=4.8.4 <6.1.0`), so the
 * package that answers `require('typescript')` is `@typescript/typescript6`,
 * installed under the `typescript` name; its only bin is `tsc6`, which is why
 * the two do not collide. The arrangement lives in `package.json`'s two
 * `npm:` aliases and nothing else says which role is which — a swap would
 * leave every typecheck target compiling with TS 6 and ESLint parsing with a
 * package that has no API, and both would still exit 0 on a clean tree.
 *
 * Proof: with no alias at all, both failed — `Expected: "6" · Received: "5"`
 * and `Received: "Version 5.9.3"`. With the two aliases swapped, both failed
 * again on `Expected: "6" · Received: "7"` and `Received: "Version 6.0.3"` —
 * the 6.0.3 being a transitive TypeScript that owned `.bin/tsc` once the
 * TS 7 package no longer did (2026-09-06).
 */
describe('the two TypeScripts', () => {
  const require = createRequire(import.meta.url);

  it('the typescript package is the TS 6 API build', () => {
    const { version } = require('typescript/package.json') as { version: string };
    expect(version.split('.')[0]).toBe('6');
  });

  it('tsc on the workspace path is TypeScript 7', () => {
    const tsc = new URL('node_modules/.bin/tsc', WORKSPACE).pathname;
    const { stdout, exitCode } = Bun.spawnSync([tsc, '--version']);
    expect(exitCode).toBe(0);
    expect(stdout.toString().trim()).toMatch(/^Version 7\./);
  });
});

/**
 * ESLint is told React's version rather than detecting it — see the
 * `settings.react.version` comment in `eslint.config.js` for why — and a told
 * version can go stale. This is the line that says when it has.
 *
 * Proof: with the pin set to `18.3.1` against React 19.2.8 installed,
 * `the React version ESLint is told is the one installed` failed on
 * `Expected: "19.2.8" · Received: "18.3.1"` (2026-09-06).
 */
describe('the React version ESLint is told', () => {
  it('is the one installed', async () => {
    const config = await read('eslint.config.js');
    const told = /settings: \{ react: \{ version: '([^']+)' \} \}/.exec(config)?.[1];
    const require = createRequire(import.meta.url);
    const { version } = require('react/package.json') as { version: string };
    expect(told).toBe(version);
  });
});
