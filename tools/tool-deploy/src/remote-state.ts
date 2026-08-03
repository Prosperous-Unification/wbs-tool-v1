import type { Tier } from './affected';

export interface RemoteTierState {
  tier: Tier;
  activeColor: 'blue' | 'green';
  lastDeployedSha: string | null;
}

const TIERS: readonly Tier[] = ['be', 'gw', 'fe'];

/**
 * One round trip for all three tiers, with each tier's file classified on the
 * far side rather than inferred from an empty body here.
 *
 * The previous command was `cat /srv/wbs/state/$t.json 2>/dev/null || true`.
 * The `|| true` was load-bearing for the case this function is meant to
 * tolerate — a never-deployed tier has no file, and `cat`'s exit code
 * survives `2>/dev/null`, so without it a fresh host failed the whole
 * invocation. But it swallowed *every* failure equally: an unreadable file
 * (EACCES, a bad mount, a directory where the file should be) produced empty
 * output, which parsed as "this tier was never deployed".
 *
 * That is not a cosmetic misreport. `hasNewMigrations` returns false for a
 * null deployed-sha — correctly, since a never-deployed tier has no previous
 * release to stay backward-compatible with — so a tier that merely *looked*
 * never-deployed silently disabled the `--with-migrations` gate for itself.
 * `chmod 000 /srv/wbs/state/be.json` was enough to deploy a destructive
 * migration with no acknowledgment at all.
 *
 * `[ -e ]` / `[ -r ]` separate the two, so "absent" stays tolerated and
 * "present but unreadable" becomes a refusal.
 */
const READ_STATE_CMD =
  'for t in be gw fe; do f=/srv/wbs/state/$t.json; ' +
  'if [ ! -e "$f" ]; then echo "== $t absent"; ' +
  'elif [ ! -r "$f" ]; then echo "== $t unreadable"; ' +
  'else echo "== $t present"; cat "$f" || echo "__CAT_FAILED__"; fi; done';

/**
 * Pure parser for READ_STATE_CMD's output. Fails closed: anything other than
 * a clean "absent" or a well-formed "present" is an error, because every
 * ambiguous reading of this data ends in a skipped safety gate.
 */
export function parseRemoteStateOutput(out: string): Partial<Record<Tier, RemoteTierState>> {
  const result: Partial<Record<Tier, RemoteTierState>> = {};
  const seen = new Set<Tier>();

  for (const block of out.split('== ').slice(1)) {
    const nl = block.indexOf('\n');
    const header = (nl === -1 ? block : block.slice(0, nl)).trim();
    // Shape checked before destructuring rather than papered over with a
    // fallback afterwards. noUncheckedIndexedAccess is off in this repo, so
    // TS would type a missing token as `string` and let a malformed header
    // flow onwards as a real tier — the length guard is what actually makes
    // the two reads below safe, and it fails closed like every other branch
    // in this parser.
    const parts = header.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(
        `remote state output had an unreadable header "${header}" — expected "<tier> <status>".`,
      );
    }
    const tierRaw = parts[0];
    const status = parts[1];
    const tier = tierRaw as Tier;
    if (!TIERS.includes(tier)) {
      throw new Error(`remote state output named an unknown tier "${tierRaw}"`);
    }
    seen.add(tier);
    const body = nl === -1 ? '' : block.slice(nl + 1).trim();

    if (status === 'absent') continue;
    if (status !== 'present') {
      throw new Error(
        `/srv/wbs/state/${tier}.json exists but could not be read (status: ${status}).\n` +
          '  Refusing rather than treating it as never-deployed: an unreadable state file\n' +
          "  would disable this tier's migration gate. Fix the file's ownership/mode.",
      );
    }
    if (body === '' || body.includes('__CAT_FAILED__')) {
      throw new Error(
        `/srv/wbs/state/${tier}.json is present but could not be read, or is empty — ` +
          'refusing rather than treating it as never-deployed.',
      );
    }
    try {
      result[tier] = JSON.parse(body) as RemoteTierState;
    } catch (e: unknown) {
      throw new Error(
        `/srv/wbs/state/${tier}.json is not valid JSON (${e instanceof Error ? e.message : String(e)}) — ` +
          'refusing rather than treating it as never-deployed.',
      );
    }
  }

  // Truncated output must not read as "every tier is a fresh install".
  const missing = TIERS.filter((t) => !seen.has(t));
  if (missing.length > 0) {
    throw new Error(
      `remote state output did not report on ${missing.join(', ')} — ` +
        'the read was truncated or the command failed partway.',
    );
  }
  return result;
}

export async function readRemoteState(
  host: string,
): Promise<Partial<Record<Tier, RemoteTierState>>> {
  const p = Bun.spawn(['ssh', host, READ_STATE_CMD], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`cannot read remote state from ${host}`);
  return parseRemoteStateOutput(out);
}
