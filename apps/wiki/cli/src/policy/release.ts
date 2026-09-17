import { hashBytes, serializeCanonical } from '../evidence/content-manifest';

/**
 * Every way the release target refuses to pack a toolkit, in the order it reaches them. A toolkit
 * carries only the roles that are identical for every repository and every commit, so each refusal
 * is about the bytes being packed, never about any consumer:
 * `T1` a tag that is not `wiki-vMAJOR.MINOR.PATCH`;
 * `T2` a tag no commit resolves;
 * `T3` a tag that is not at HEAD, so the packed bytes would not be the tagged ones;
 * `T4` a checkout with uncommitted or untracked paths, for the same reason;
 * `T5` an operator Bun other than `.bun-version`, because the bundle's digest is what this Bun
 *      produces and a consumer's runner pins the same version;
 * `T6` a validator bundle that is not standalone, which would load unreviewed bytes at admission
 *      (a contract guard with no observed negative — see the comment at its throw site);
 * `T7` a destination inside the checkout being released: the toolkit is read from that tree and
 *      the clean-tree check has already measured it. A trusted node module that is absent or a
 *      symlink is raised by `trusted-modules.ts` as `R19` and surfaced unchanged, because it is the
 *      same fact about the same role;
 * `T9` an installed `typescript` whose version is not the one the checkout's `package.json` pins —
 *      `node_modules/` is git-ignored, so the clean-tree check cannot see it at all;
 * `T8` a destination that already holds a toolkit, or an archive path that already exists — the
 *      tar may already be published under that digest;
 */
export type ReleaseRefusalCode = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9';

/** A named refusal to pack a toolkit; the message always names the offending tag, path or value. */
export class ReleaseRefusal extends Error {
  constructor(
    readonly code: ReleaseRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ReleaseRefusal';
  }
}

const ReleaseTag = /^wiki-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const CommitIdentity = /^[0-9a-f]{40}$/;

/**
 * The toolkit members, in the order `SHA256SUMS` lists them. `trusted-node-modules/` is a
 * directory rather than a member: `toolkit.json`'s `trustedNodeModulesIdentity` — one digest over
 * every file in the copied closure, from `hashTrustedModules` in `trusted-modules.ts` — is what
 * pins its bytes, because the closure is 24 MB of vendored TypeScript whose per-file list would
 * dwarf the descriptor it lives in.
 */
export const toolkitRoles = [
  'launcher.sh',
  'snapshotter.ts',
  'validator.mjs',
  'prepare-activation.mjs',
] as const;

export type ToolkitRole = (typeof toolkitRoles)[number];

export interface ToolkitPlanRequest {
  readonly tag: string;
  readonly sourceRevision: string;
  readonly bunVersion: string;
  readonly roleBytes: Readonly<Record<ToolkitRole, Uint8Array>>;
  readonly trustedNodeModules: readonly string[];
  /** `hashTrustedModules` over the copied closure, the only thing that pins its 24 MB. */
  readonly trustedNodeModulesIdentity: string;
}

export interface ToolkitPlan {
  /** Canonical `toolkit.json`, the descriptor a consumer's preparer digest-checks each role against. */
  readonly descriptor: Uint8Array;
  /** `SHA256SUMS` over every member including `toolkit.json`, in `sha256sum --check` form. */
  readonly checksums: Uint8Array;
  readonly digests: Readonly<Record<ToolkitRole, string>>;
}

/**
 * Refuses a tag that is not exactly `wiki-vMAJOR.MINOR.PATCH`. The form is the whole contract a
 * consumer reads off a release page, so a pre-release or a two-part version is refused rather than
 * normalized.
 * @throws {@link ReleaseRefusal} `T1`.
 */
export function assertReleaseTag(tag: string): void {
  // Proof: forcing this refusal false packed `wiki-v1` into `wiki-wiki-v1.tar` and wrote a
  // `toolkit.json` whose `tag` no release page could carry; the T1 negative received a printed
  // archive path at exit 0.
  if (!ReleaseTag.test(tag)) {
    throw new ReleaseRefusal('T1', `release tag is malformed: ${tag}`);
  }
}

/**
 * Refuses a tag that resolves to nothing, and a tag whose commit is not the checkout's HEAD —
 * every role is read from the working tree or rebuilt from it, so a tag elsewhere would label
 * bytes it does not name.
 * @throws {@link ReleaseRefusal} `T2` or `T3`.
 */
export function assertTagAtHead(tag: string, tagCommit: string | undefined, head: string): void {
  // Proof: forcing this refusal false let an unknown tag reach the HEAD comparison, which then
  // refused with `release tag is not at HEAD: undefined != <head>` and sent the operator to a
  // tag-placement fix for a tag that does not exist.
  if (tagCommit === undefined || !CommitIdentity.test(tagCommit)) {
    throw new ReleaseRefusal('T2', `release tag is unknown: ${tag}`);
  }
  // Proof: forcing this refusal false packed the working tree's bytes under a tag pointing at the
  // parent commit; the T3 negative received a complete archive at exit 0, so `toolkit.json` named
  // a commit whose `bin/tool-wiki-lint.sh` was not the `launcher.sh` inside it.
  if (tagCommit !== head) {
    throw new ReleaseRefusal('T3', `release tag is not at HEAD: ${tagCommit} != ${head}`);
  }
}

/**
 * Refuses a checkout with any uncommitted or untracked path, because the toolkit is read from the
 * working tree and `toolkit.json` claims it is the tag's commit.
 * @throws {@link ReleaseRefusal} `T4` naming the first offending paths.
 */
export function assertCleanCheckout(porcelain: readonly string[]): void {
  const paths = porcelain.filter((line) => line.length > 0).map((line) => line.slice(3));
  // Proof: forcing this refusal false packed an edited `bin/tool-wiki-lint.sh` as the tag's
  // `launcher.sh`; the T4 negative received a printed archive path at exit 0 and a `toolkit.json`
  // digest that matched no committed blob.
  if (paths.length > 0) {
    throw new ReleaseRefusal('T4', `checkout is dirty: ${paths.slice(0, 3).join(', ')}`);
  }
}

/**
 * Refuses an operator Bun other than the checkout's `.bun-version`: the validator bundle's digest
 * is what this Bun produces, and a consumer's runner pins the same version to reproduce it.
 * @throws {@link ReleaseRefusal} `T5`.
 */
export function assertReleaseRuntime(actual: string, pinned: string): void {
  // Proof: forcing this refusal false packed a bundle built by Bun 1.3.9 under a `toolkit.json`
  // claiming 1.4.2; the T5 negative received a complete archive at exit 0.
  if (actual !== pinned.trim()) {
    throw new ReleaseRefusal(
      'T5',
      `operator Bun differs from .bun-version: ${actual} != ${pinned.trim()}`,
    );
  }
}

/**
 * Refuses a destination that already holds a toolkit, and an archive path that already exists, so a
 * second run never half-overwrites either one — the tar may already be published under its digest.
 * @throws {@link ReleaseRefusal} `T8`.
 */
export function assertDestinationFree(
  destination: string,
  occupied: boolean,
  archivePath: string,
  archiveExists: boolean,
): void {
  // Proof: forcing this refusal false wrote a second `toolkit.json` beside the first run's
  // `trusted-node-modules`, and the printed sha256 described an archive mixing both; the T8
  // negative received a printed archive path at exit 0.
  if (occupied) {
    throw new ReleaseRefusal('T8', `destination already holds a toolkit: ${destination}`);
  }
  // Proof: forcing this refusal false overwrote an existing `wiki-v0.0.1.tar` beside a fresh
  // destination; the negative received a printed archive path at exit 0, so a tar an operator may
  // already have published under its digest was replaced in place.
  if (archiveExists) {
    throw new ReleaseRefusal('T8', `toolkit archive already exists: ${archivePath}`);
  }
}

/**
 * Refuses a destination inside the checkout being released: the toolkit is read from that tree and
 * `assertCleanCheckout` has already measured it, so writing into it makes the archive describe a
 * tree that no longer matches the commit `toolkit.json` names.
 * @throws {@link ReleaseRefusal} `T7`.
 */
export function assertDestinationOutside(repository: string, destination: string): void {
  // Proof: forcing this refusal false wrote the whole toolkit, including 24 MB of vendored
  // TypeScript, inside the checkout it had just verified clean; the negative packed an archive at
  // exit 0 and left the release tree dirty for every later run. `destination` is the canonical
  // path of its nearest existing ancestor, so a symlink pointing into the checkout is caught too.
  if (destination === repository || destination.startsWith(`${repository}/`)) {
    throw new ReleaseRefusal(
      'T7',
      `destination must be outside the checkout being released: ${destination}`,
    );
  }
}

/**
 * The version a `package.json` dependency pin names, including npm aliases: `6.0.2` out of both
 * `6.0.2` and `npm:@typescript/typescript6@6.0.2`.
 */
function pinnedVersion(specifier: string): string {
  return specifier.startsWith('npm:') ? (specifier.split('@').pop() ?? specifier) : specifier;
}

/**
 * Refuses an installed `typescript` that is not the version the checkout pins. `node_modules/` is
 * git-ignored, so {@link assertCleanCheckout} cannot see it and nothing else joins the closure the
 * toolkit ships to the lockfile the tag committed — yet `toolkit.json` claims that closure is the
 * tag's.
 * @throws {@link ReleaseRefusal} `T9` naming both versions.
 */
export function assertPinnedTypeScript(pinSpecifier: string | undefined, installed: string): void {
  // Proof: forcing this refusal false packed a `trusted-node-modules` built from a stale install
  // under a `toolkit.json` claiming the tag's commit; the negative received a complete archive at
  // exit 0, and every consumer preparing from it would load a TypeScript the tag never pinned.
  if (pinSpecifier === undefined) {
    throw new ReleaseRefusal('T9', 'checkout pins no typescript dependency to release against');
  }
  const pinned = pinnedVersion(pinSpecifier);
  if (pinned !== installed) {
    throw new ReleaseRefusal(
      'T9',
      `installed typescript is not the pinned one: ${installed} != ${pinned}`,
    );
  }
}

/**
 * Derives the two descriptors a toolkit carries. Pure: every byte comes from the request, so the
 * same tag, commit, Bun and role bytes always produce the same `toolkit.json` and `SHA256SUMS`.
 */
export function planToolkit(request: ToolkitPlanRequest): ToolkitPlan {
  // `Object.fromEntries` widens to `Record<string, string>`; the entries are exactly `toolkitRoles`
  // mapped one-to-one, which is the key set of the asserted type, so the cast is discharged here.
  const digests = Object.fromEntries(
    toolkitRoles.map((role) => [role, hashBytes(request.roleBytes[role])]),
  ) as Record<ToolkitRole, string>;
  const descriptor = new TextEncoder().encode(
    serializeCanonical({
      schemaVersion: 1,
      tag: request.tag,
      sourceRevision: request.sourceRevision,
      bunVersion: request.bunVersion,
      roles: digests,
      trustedNodeModules: [...request.trustedNodeModules].sort(),
      trustedNodeModulesIdentity: request.trustedNodeModulesIdentity,
    }),
  );
  const lines = [
    ...toolkitRoles.map((role) => `${digests[role]}  ./${role}`),
    `${hashBytes(descriptor)}  ./toolkit.json`,
  ];
  return {
    descriptor,
    checksums: new TextEncoder().encode(`${lines.join('\n')}\n`),
    digests,
  };
}
