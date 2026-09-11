import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { hashCanonical } from '../evidence/content-manifest';
import type { CandidateEntry, CandidateSnapshot } from '../inventory/read-candidate';
import {
  type CandidateBytes,
  markdownAnchors,
  markdownText,
  type ReadIndex,
  readIndexes,
} from './read-indexes';

// Proof: raising this to 41 made the forty-one-entry CLI return `reviewDebt: []`; the test
// expected one debt record with the immutable source tree still clean.
const DirectEntryLimit = 40;
const GlobPattern = /[*?[\]{}]/;

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function isBelow(path: string, directory: string): boolean {
  return directory === '' || path.startsWith(`${directory}/`);
}

function joinIndexPath(index: ReadIndex, localPath: string): string {
  const joined = index.directory === '' ? localPath : posix.join(index.directory, localPath);
  if (posix.isAbsolute(joined) || joined === '..' || joined.startsWith('../')) {
    throw new Error(`membership escapes index boundary in ${index.indexPath}: ${localPath}`);
  }
  return joined;
}

function ownerOf(path: string, indexes: readonly ReadIndex[]): ReadIndex | undefined {
  const candidates = indexes
    .filter((index) => isBelow(path, index.directory))
    .sort((left, right) => right.directory.length - left.directory.length);
  if (candidates.length === 0) return undefined;
  const nearest = candidates[0];
  if (nearest.indexPath !== path) return nearest;
  return candidates[1];
}

function expectedMembers(
  index: ReadIndex,
  indexes: readonly ReadIndex[],
  paths: readonly string[],
): string[] {
  return paths
    .filter(
      (path) => path !== index.indexPath && ownerOf(path, indexes)?.indexPath === index.indexPath,
    )
    .sort(compareText);
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function declaredMembers(
  index: ReadIndex,
  expected: readonly string[],
  candidatePaths: ReadonlySet<string>,
  entries: ReadonlyMap<string, CandidateEntry>,
  bytes: CandidateBytes,
): string[] {
  const claims = new Map<string, number>();
  for (const membership of index.metadata.memberships) {
    if (membership.kind === 'path') {
      const path = joinIndexPath(index, membership.path);
      // Proof: ignoring this absent exact member moved the production CLI failure to the later
      // Markdown-path check (`Markdown path absent in README.md: docs/guide.md`).
      if (!candidatePaths.has(path)) throw new Error(`membership target absent: ${path}`);
      assertMemberContained(index, path, entries, candidatePaths, bytes);
      if (!expected.includes(path)) {
        throw new Error(`membership target outside ${index.indexPath}: ${path}`);
      }
      claims.set(path, (claims.get(path) ?? 0) + 1);
      continue;
    }
    const prefix = joinIndexPath(index, membership.prefix);
    const exclusions = membership.exclusions.map((excluded) => joinIndexPath(index, excluded));
    const matched = expected.filter(
      (path) => (path === prefix || path.startsWith(`${prefix}/`)) && !isExcluded(path, exclusions),
    );
    if (matched.length === 0) throw new Error(`membership target absent: ${prefix}`);
    for (const path of matched) {
      assertMemberContained(index, path, entries, candidatePaths, bytes);
      claims.set(path, (claims.get(path) ?? 0) + 1);
    }
  }
  for (const path of expected) {
    const count = claims.get(path) ?? 0;
    // Proof: removing this refusal made the added-child production CLI exit 0 while omitting
    // `unindexed.txt` from every index report (expected exit 1, received 0).
    if (count === 0) throw new Error(`unindexed candidate path in ${index.indexPath}: ${path}`);
    // Proof: removing this refusal let the overlapping test path through; the CLI failed only
    // later on the fixture's omitted frozen-proposal link instead of naming the ambiguity.
    if (count > 1) throw new Error(`ambiguous membership in ${index.indexPath}: ${path}`);
  }
  return [...claims.keys()].sort(compareText);
}

function assertMemberContained(
  index: ReadIndex,
  target: string,
  entries: ReadonlyMap<string, CandidateEntry>,
  candidatePaths: ReadonlySet<string>,
  bytes: CandidateBytes,
): void {
  let resolved = target;
  const visited = new Set<string>();
  while (entries.get(resolved)?.mode === '120000') {
    if (visited.has(resolved)) {
      // Proof: returning on revisit made `first -> second -> first` exit 0 with both cycle members
      // reported as owned (expected exit 1, received 0).
      throw new Error(`membership symlink cycle in ${index.indexPath}: ${resolved}`);
    }
    visited.add(resolved);
    const linkTarget = markdownText(resolved, bytes);
    const next = posix.normalize(posix.join(posix.dirname(resolved), linkTarget));
    // Proof: removing these member checks made both unlinked exact and grouped escaping-symlink
    // production CLIs exit 0 and report the escaping symlink as an owned member.
    // Proof: omitting the absolute-target branch moved `/outside` to the less precise
    // `membership symlink target absent` failure instead of naming the escape.
    if (posix.isAbsolute(linkTarget) || next === '..' || next.startsWith('../')) {
      throw new Error(
        `membership symlink escapes candidate in ${index.indexPath}: ${resolved} -> ${linkTarget}`,
      );
    }
    // Proof: omitting selected-target membership made `missing -> not-selected` exit 0 and report
    // the dangling symlink as an owned member (expected exit 1, received 0).
    if (!candidatePaths.has(next)) {
      throw new Error(
        `membership symlink target absent in ${index.indexPath}: ${resolved} -> ${linkTarget}`,
      );
    }
    resolved = next;
  }
}

function decodeDestination(
  indexPath: string,
  destination: string,
): { path: string; anchor?: string } {
  const hash = destination.indexOf('#');
  const rawPath = hash < 0 ? destination : destination.slice(0, hash);
  const rawAnchor = hash < 0 ? undefined : destination.slice(hash + 1);
  let path: string;
  let anchor: string | undefined;
  try {
    path = decodeURIComponent(rawPath);
    anchor = rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Markdown link malformed in ${indexPath}: ${destination}: ${detail}`, {
      cause,
    });
  }
  return anchor === undefined ? { path } : { path, anchor };
}

function resolveLinkPath(index: ReadIndex, localPath: string): string {
  if (localPath.length === 0) return index.indexPath;
  if (posix.isAbsolute(localPath)) {
    throw new Error(`Markdown path escapes candidate in ${index.indexPath}: ${localPath}`);
  }
  const joined = posix.normalize(posix.join(index.directory, localPath));
  if (joined === '..' || joined.startsWith('../')) {
    throw new Error(`Markdown path escapes candidate in ${index.indexPath}: ${localPath}`);
  }
  return joined;
}

function exactCandidatePath(
  sourcePath: string,
  requested: string,
  candidatePaths: ReadonlySet<string>,
): string {
  if (candidatePaths.has(requested)) return requested;
  const directoryIndex = requested.length === 0 ? 'README.md' : `${requested}/README.md`;
  if (candidatePaths.has(directoryIndex)) return directoryIndex;
  const folded = requested.toLocaleLowerCase('en-US');
  const caseMatches = [...candidatePaths].filter(
    (path) =>
      path.toLocaleLowerCase('en-US') === folded ||
      path.toLocaleLowerCase('en-US') === `${folded}/readme.md`,
  );
  // Proof: replacing this exact-case diagnosis with ordinary absence made the wrong-case CLI
  // receive `Markdown path absent in README.md: docs/Guide.md`, missing its required assertion.
  if (caseMatches.length === 1) {
    throw new Error(
      `Markdown path case mismatch in ${sourcePath}: ${requested} -> ${caseMatches[0]}`,
    );
  }
  if (caseMatches.length > 1) {
    throw new Error(`Markdown path case is ambiguous in ${sourcePath}: ${requested}`);
  }
  throw new Error(`Markdown path absent in ${sourcePath}: ${requested}`);
}

function resolveSymlinks(
  index: ReadIndex,
  target: string,
  entries: ReadonlyMap<string, CandidateEntry>,
  candidatePaths: ReadonlySet<string>,
  bytes: CandidateBytes,
): string {
  let resolved = target;
  const visited = new Set<string>();
  while (entries.get(resolved)?.mode === '120000') {
    if (visited.has(resolved)) {
      throw new Error(`Markdown symlink cycle in ${index.indexPath}: ${resolved}`);
    }
    visited.add(resolved);
    const linkTarget = markdownText(resolved, bytes);
    if (posix.isAbsolute(linkTarget)) {
      throw new Error(
        `Markdown symlink escapes candidate in ${index.indexPath}: ${resolved} -> ${linkTarget}`,
      );
    }
    const next = posix.normalize(posix.join(posix.dirname(resolved), linkTarget));
    resolved = exactCandidatePath(index.indexPath, next, candidatePaths);
  }
  return resolved;
}

function checkLinks(
  index: ReadIndex,
  entries: ReadonlyMap<string, CandidateEntry>,
  candidatePaths: ReadonlySet<string>,
  bytes: CandidateBytes,
): void {
  for (const link of index.links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.destination) || link.destination.startsWith('//')) {
      continue;
    }
    const destination = decodeDestination(index.indexPath, link.destination);
    // Proof: skipping globbed links made `tests/*.ts` disappear from validation and the
    // production CLI exit 0 with all three indexes (expected exit 1, received 0).
    if (GlobPattern.test(destination.path)) {
      throw new Error(`Markdown link contains a glob in ${index.indexPath}: ${destination.path}`);
    }
    const requested = resolveLinkPath(index, destination.path);
    const selectedTarget = exactCandidatePath(index.indexPath, requested, candidatePaths);
    const target = resolveSymlinks(index, selectedTarget, entries, candidatePaths, bytes);
    if (destination.anchor === undefined || destination.anchor.length === 0) continue;
    const anchors = markdownAnchors(markdownText(target, bytes));
    // Proof: skipping this branch made the missing-anchor production CLI exit 0 with all three
    // indexes reported (expected exit 1, received 0).
    if (!anchors.has(destination.anchor)) {
      throw new Error(
        `Markdown anchor absent in ${index.indexPath}: ${requested}#${destination.anchor}`,
      );
    }
  }
}

function checkArchiveEntrypoints(index: ReadIndex, members: readonly string[]): void {
  const proposals = members.filter(
    (path) => path.startsWith('openspec/changes/archive/') && path.endsWith('/proposal.md'),
  );
  for (const proposal of proposals) {
    const linked = index.links.some(({ destination }) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) return false;
      const decoded = decodeDestination(index.indexPath, destination);
      return resolveLinkPath(index, decoded.path) === proposal;
    });
    if (!linked) throw new Error(`frozen archive proposal has no index entrypoint: ${proposal}`);
  }
}

/** Checks exact nearest-index ownership and every candidate-relative Markdown reference. */
export function checkIndexes(repository: string, candidate: CandidateSnapshot): object {
  const read = readIndexes(repository, candidate);
  // Proof: without this guard a candidate containing only an ordinary README exited 0 with
  // `indexes: []` and `reviewDebt: []` (expected exit 1, received 0).
  if (read.indexes.length === 0) throw new Error('selected candidate contains no wbs indexes');
  const paths = candidate.entries.map(({ path }) => path);
  const candidatePaths = new Set(paths);
  const entries = new Map(candidate.entries.map((entry) => [entry.path, entry]));
  const moduleIds = new Set<string>();
  const checked = read.indexes.map((index) => {
    // Proof: removing this guard made the duplicate-module production CLI exit 0 and report
    // `module.alpha` for both nested indexes (expected exit 1, received 0).
    if (moduleIds.has(index.metadata.moduleId)) {
      throw new Error(`duplicate index module identity: ${index.metadata.moduleId}`);
    }
    moduleIds.add(index.metadata.moduleId);
    const expected = expectedMembers(index, read.indexes, paths);
    const members = declaredMembers(index, expected, candidatePaths, entries, read.bytes);
    checkLinks(index, entries, candidatePaths, read.bytes);
    checkArchiveEntrypoints(index, members);
    return {
      indexPath: index.indexPath,
      moduleId: index.metadata.moduleId,
      identity: index.identity,
      members,
    };
  });
  const reviewDebt = read.indexes
    .filter(({ metadata }) => metadata.memberships.length > DirectEntryLimit)
    .map(({ indexPath, metadata }) => ({
      indexPath,
      directEntries: metadata.memberships.length,
      limit: DirectEntryLimit,
    }));
  return {
    schemaVersion: 1,
    selection: candidate.selection,
    identity: hashCanonical({
      schemaVersion: 1,
      indexes: checked.map(({ indexPath, identity, members }) => ({
        indexPath,
        identity,
        members,
      })),
    }),
    indexes: checked,
    reviewDebt,
  };
}
