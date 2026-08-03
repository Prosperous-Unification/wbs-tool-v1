#!/usr/bin/env bun
/**
 * Local dev setup: copies `.env.example` → `.env` for each app whose `.env` is
 * missing. Non-destructive — never overwrites an existing `.env`.
 *
 * Run via: `bun run dev:setup`. See docs/local-dev.md.
 *
 * The two skips below are not the same kind of skip, which is why they are not
 * handled the same way. An existing `.env` is the expected steady state and the
 * whole reason this script is non-destructive. A missing `.env.example` is a
 * broken checkout: the file is committed, so its absence means the clone is
 * incomplete or the app was renamed. This used to log "skipping" for both and
 * exit 0, so a broken checkout produced a green setup and the failure surfaced
 * later as an unexplained missing-env crash at serve time.
 *
 * Proof: `seedApps` with an app name that has no `.env.example` throws
 * MissingEnvExampleError. See setup.test.ts.
 */
import { existsSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const APPS: readonly string[] = ['be-01', 'gw-01', 'fe-01'];

/** Thrown when a committed `.env.example` is absent, meaning a broken checkout. */
export class MissingEnvExampleError extends Error {
  constructor(readonly app: string) {
    super(
      `apps/${app}/.env.example is missing. It is committed, so this checkout is ` +
        `incomplete or the app was renamed. Dev cannot be seeded — fix the checkout ` +
        `rather than running without an .env.`,
    );
    this.name = 'MissingEnvExampleError';
  }
}

export type SeedOutcome = 'wrote' | 'already-present';

export async function seedApp(app: string, root: string = ROOT): Promise<SeedOutcome> {
  const example = resolve(root, 'apps', app, '.env.example');
  const target = resolve(root, 'apps', app, '.env');
  if (!existsSync(example)) throw new MissingEnvExampleError(app);
  if (existsSync(target)) return 'already-present';
  await copyFile(example, target);
  return 'wrote';
}

export async function seedApps(
  apps: readonly string[] = APPS,
  root: string = ROOT,
): Promise<Record<string, SeedOutcome>> {
  const outcomes: Record<string, SeedOutcome> = {};
  for (const app of apps) outcomes[app] = await seedApp(app, root);
  return outcomes;
}

async function main(): Promise<void> {
  console.log('[dev:setup] seeding local .env files (non-destructive)');
  const outcomes = await seedApps();
  for (const [app, outcome] of Object.entries(outcomes)) {
    console.log(
      outcome === 'wrote'
        ? `[dev:setup] ${app}: wrote apps/${app}/.env`
        : `[dev:setup] ${app}: .env already exists — left alone`,
    );
  }
  console.log('[dev:setup] done. run `bun run dev` to start be-01 + gw-01 + fe-01.');
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error('[dev:setup] failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
