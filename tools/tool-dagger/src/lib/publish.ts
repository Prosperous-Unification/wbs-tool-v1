import { IMAGE_NAME, type Tier } from '@tools/deploy-contract';

// Re-exported because this module's own callers take `Tier` from it. The image
// names came from a second copy here until 2026-09-02, and they are the pair
// that had to agree: `swap.js` refuses a ref that does not name the tier it was
// asked to swap, so a drift would have passed the build and failed the deploy
// on the server, mid-swap.
export type { Tier };

const DIGEST_RE = /@(sha256:[0-9a-f]{64})\b/;

export interface ReleaseEntry {
  sha: string;
  digest: string;
  /** The tagged ref this was pushed to. Traceability only; nothing pulls it. */
  ref: string;
  /**
   * The digest-pinned ref the deploy pulls, registry address included.
   *
   * This is the single source of truth for the publish address, and it exists
   * because there previously wasn't one. `tool-dagger` and the server-side
   * `swap.js` each carried their own `REGISTRY` default and each rebuilt the
   * ref from it, while `tool-deploy` — the only thing that talks to both —
   * passed the bare digest across and no address at all. The two defaults were
   * free to disagree, and did: every live swap so far only worked because it
   * was hand-invoked with `REGISTRY=127.0.0.1:5000` on the server, so the
   * committed orchestrator would have rendered the public hostname and 401'd
   * at `docker compose up --pull always`. Recording the whole ref here, and
   * carrying it verbatim through `release.json` -> `tool-deploy` -> `swap.js`,
   * removes the second copy of the address rather than trying to keep two in
   * sync.
   */
  image: string;
}

export type ReleaseRecord = Partial<Record<Tier, ReleaseEntry>>;

export function imageRef(registry: string, tier: Tier, sha: string): string {
  if (sha.trim() === '') {
    throw new Error('refusing to build an image ref with an empty sha');
  }
  return `${registry}/${IMAGE_NAME[tier]}:${sha}`;
}

/**
 * The ref a deploy pulls: pinned by digest, never by tag (design decision 4 —
 * a rebuild on a different build host can move a tag but cannot move a
 * digest).
 */
export function digestRef(registry: string, tier: Tier, digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`not a well-formed sha256 digest: ${digest}`);
  }
  return `${registry}/${IMAGE_NAME[tier]}@${digest}`;
}

/**
 * Deploys pull by digest, never by tag — a rebuild on a different build host can
 * move a tag but cannot move a digest. A publish that reports no digest is a
 * hard failure rather than a silent downgrade to tag-based deploys.
 */
export function parseDigest(publishOutput: string): string {
  const m = DIGEST_RE.exec(publishOutput);
  if (!m?.[1]) {
    throw new Error(`no digest found in publish output: ${publishOutput}`);
  }
  return m[1];
}

export function renderRelease(rec: ReleaseRecord): string {
  return JSON.stringify(rec, null, 2) + '\n';
}
