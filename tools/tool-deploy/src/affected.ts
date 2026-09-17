import type { Tier } from '@tools/deploy-contract';
import { type EnvLayout, envLayout } from '@tools/env';

// Re-exported because every module in this project takes `Tier` from here.
// Declared here in its own words until 2026-09-02, which made four
// declarations of one three-word union across the deploy tools.
export type { Tier };

export interface DeployArgs {
  tiers: Tier[] | 'affected' | 'all';
  /**
   * The environment being deployed. Resolved at parse time rather than carried
   * as a string, so an unknown `--env` is refused before a plan exists rather
   * than turning into a path somewhere downstream.
   */
  layout: EnvLayout;
  bundle?: string;
  host?: string;
  dryRun: boolean;
  /** Acknowledges the deploy carries a reviewed, additive-only migration. */
  withMigrations: boolean;
  /** Acknowledges the deploy carries a migration too risky for blue/green; plain restart, brief outage. */
  stopTheWorld: boolean;
}

function parseTierArg(v: string): Tier[] {
  const ts = v
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  for (const t of ts) {
    if (t !== 'be' && t !== 'gw' && t !== 'fe') {
      throw new Error(`unknown tier: ${t}`);
    }
  }
  return ts as Tier[];
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const result: DeployArgs = {
    tiers: 'affected',
    layout: envLayout(undefined),
    dryRun: true,
    withMigrations: false,
    stopTheWorld: false,
  };
  const positional: string[] = [];

  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      positional.push(raw);
      continue;
    }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    // An unparseable flag used to be skipped silently. `--env=prod` typed as
    // `--envv=prod` then deployed to prod anyway, because envLayout(undefined)
    // defaults there — the safety of that default depends on the operator
    // having meant it.
    if (!m) throw new Error(`unrecognised argument: ${raw}`);
    const key = m[1];
    const val = (m[2] as string | undefined) ?? '';
    if (key === 'all') result.tiers = 'all';
    // envLayout throws on anything it does not know, and that throw is the
    // point: `--env=stagign` must stop here, not resolve to prod and deploy an
    // unreviewed commit onto the live site.
    else if (key === 'env') result.layout = envLayout(val);
    else if (key === 'bundle') result.bundle = val;
    else if (key === 'host') result.host = val;
    else if (key === 'dry-run') result.dryRun = true;
    else if (key === 'execute') result.dryRun = false;
    else if (key === 'with-migrations') result.withMigrations = true;
    else if (key === 'stop-the-world') result.stopTheWorld = true;
    // --since, --version and --skip-build were accepted and then read by
    // nothing: `grep -rn '\.since\b' tools/` matches this parser and no other
    // line. `--version=v1.2.3` looked like a rollback and deployed HEAD, which
    // is the most expensive way for a flag to be a no-op. Rejected outright,
    // in the same spirit as --stop-the-world: a flag that claims a capability
    // it does not have is worse than no flag.
    else if (key === 'since' || key === 'version' || key === 'skip-build') {
      throw new Error(
        `--${key} is not implemented and was previously ignored.\n` +
          '  This tool always deploys HEAD from the release bundle. It has no\n' +
          '  historical or version-selected deploy, and no way to skip the build.\n' +
          '  To deploy an older commit, check it out, rebuild, and deploy from there.',
      );
    } else throw new Error(`unrecognised flag: --${key}`);
  }

  if (positional.length > 0) {
    const parsed = parseTierArg(positional.join(','));
    if (parsed.length > 0) result.tiers = parsed;
  }

  return result;
}

export function materialize(args: DeployArgs, affected: Tier[]): Tier[] {
  if (args.tiers === 'all') return ['be', 'gw', 'fe'];
  if (args.tiers === 'affected') return affected;
  return args.tiers;
}
