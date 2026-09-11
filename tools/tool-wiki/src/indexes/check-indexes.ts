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
  symlinkTarget,
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

function isCandidateDirectory(path: string, candidatePaths: ReadonlySet<string>): boolean {
  if (path.length === 0) return true;
  return [...candidatePaths].some((candidatePath) => candidatePath.startsWith(`${path}/`));
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

function externalConsumers(
  index: ReadIndex,
  ownedMembers: readonly string[],
  candidatePaths: ReadonlySet<string>,
): string[] {
  if (index.metadata.externalConsumers.kind === 'none-known') return [];
  const consumers = new Set<string>();
  for (const membership of index.metadata.externalConsumers.memberships) {
    if (membership.kind === 'path') {
      // External-consumer memberships are candidate-root-relative, unlike owned memberships,
      // because a consumer necessarily lives outside the indexed boundary.
      // Proof: omitting this refusal made production lint certify `consumer/absent.ts`; the
      // external-consumer oracle expected exit 1 and received accepted true.
      if (!candidatePaths.has(membership.path)) {
        throw new Error(
          `external consumer target absent in ${index.indexPath}: ${membership.path}`,
        );
      }
      consumers.add(membership.path);
      continue;
    }
    const matches = [...candidatePaths].filter(
      (path) =>
        (path === membership.prefix || path.startsWith(`${membership.prefix}/`)) &&
        !isExcluded(path, membership.exclusions),
    );
    if (matches.length === 0) {
      throw new Error(
        `external consumer target absent in ${index.indexPath}: ${membership.prefix}`,
      );
    }
    for (const path of matches) consumers.add(path);
  }
  for (const consumer of consumers) {
    if (ownedMembers.includes(consumer)) {
      throw new Error(`external consumer is owned by ${index.indexPath}: ${consumer}`);
    }
  }
  return [...consumers].sort(compareText);
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
  // Proof: bypassing selected-path resolution made both unlinked escaping member CLIs exit 0
  // and report the symlinks as owned (both expected exit 1, both received 0).
  resolveSelectedPath(index, '', target, 'membership', entries, candidatePaths, bytes);
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

function canonicalLinkPath(index: ReadIndex, localPath: string): string {
  if (localPath.length === 0) return index.indexPath;
  if (posix.isAbsolute(localPath)) {
    throw new Error(`Markdown path escapes candidate in ${index.indexPath}: ${localPath}`);
  }
  const normalized = posix.normalize(posix.join(index.directory, localPath));
  // Proof: returning `normalized` unchanged made the trailing-directory anchor diagnostic say
  // `docs/#missing` instead of canonical `docs#missing`.
  const joined =
    normalized === '.' || normalized === './'
      ? ''
      : normalized.endsWith('/')
        ? normalized.slice(0, -1)
        : normalized;
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

interface SymlinkCompletion {
  completedSymlink: string;
}

function hasPendingPathComponent(pending: readonly (string | SymlinkCompletion)[]): boolean {
  return pending.some((component) => typeof component === 'string');
}

function resolveSelectedPath(
  index: ReadIndex,
  baseDirectory: string,
  localPath: string,
  purpose: 'Markdown' | 'membership',
  entries: ReadonlyMap<string, CandidateEntry>,
  candidatePaths: ReadonlySet<string>,
  bytes: CandidateBytes,
): string {
  const segments = baseDirectory.length === 0 ? [] : baseDirectory.split('/');
  const pending: (string | SymlinkCompletion)[] = localPath.split('/');
  const activePaths = new Set<string>();
  const activeSymlinks: { path: string; target: string }[] = [];
  const fallbackDirectories = new Set<string>();
  for (;;) {
    if (pending.length === 0) {
      const selectedPath = segments.join('/');
      // Proof: requiring a concrete entry here made contained `docs-link -> docs` fail with
      // `Markdown path absent in README.md: docs` even though selected descendants make it a
      // directory (expected exit 0, received 1).
      if (purpose === 'membership' && isCandidateDirectory(selectedPath, candidatePaths)) {
        return selectedPath;
      }
      if (isCandidateDirectory(selectedPath, candidatePaths)) {
        // Proof: removing this repeated-fallback refusal made both directory-README cycle CLIs
        // reach their 3 s bound with `exitCode: null` (expected exit 1).
        if (fallbackDirectories.has(selectedPath)) {
          throw new Error(
            `Markdown directory README cycle in ${index.indexPath}: ${selectedPath || '.'}`,
          );
        }
        fallbackDirectories.add(selectedPath);
        // Proof: returning the directory's selected README directly made `docs/README.md`
        // symlink bytes parse as Markdown, so the production CLI failed at `docs#details`
        // (expected exit 0, received 1).
        pending.push('README.md');
        continue;
      }
      return exactCandidatePath(index.indexPath, selectedPath, candidatePaths);
    }
    const component = pending.shift();
    if (component === undefined) throw new Error('selected path resolver lost a queued component');
    if (typeof component !== 'string') {
      const completed = activeSymlinks.pop();
      if (completed?.path !== component.completedSymlink) {
        throw new Error(`selected path resolver completed symlinks out of order`);
      }
      // Proof: retaining completed paths made `docs-link/../docs-link/guide.md` fail with
      // `Markdown symlink cycle in README.md: docs-link` (expected exit 0, received 1).
      activePaths.delete(component.completedSymlink);
      continue;
    }
    if (component === '' || component === '.') continue;
    if (component === '..') {
      if (segments.pop() === undefined) {
        const activeSymlink = activeSymlinks.at(-1);
        if (activeSymlink !== undefined) {
          throw new Error(
            `${purpose} symlink escapes candidate in ${index.indexPath}: ${activeSymlink.path} -> ${activeSymlink.target}`,
          );
        }
        throw new Error(`Markdown path escapes candidate in ${index.indexPath}: ${localPath}`);
      }
      continue;
    }
    segments.push(component);
    const selectedPath = segments.join('/');
    const entry = entries.get(selectedPath);
    // Proof: treating a selected symlink as an ordinary entry made `docs-link/guide.md` fail
    // with `Markdown path component is not a directory ... docs-link` (expected exit 0).
    if (entry?.mode === '120000') {
      if (activePaths.has(selectedPath)) {
        // Proof: returning on revisit made `first -> second -> first` exit 0 with both cycle
        // members reported as owned (expected exit 1, received 0).
        throw new Error(`${purpose} symlink cycle in ${index.indexPath}: ${selectedPath}`);
      }
      const target = symlinkTarget(selectedPath, bytes);
      // Proof: omitting the absolute-target distinction moved `/outside` to the less precise
      // membership-target-absent failure instead of naming the candidate escape.
      if (target.length === 0 || target.includes('\u0000') || posix.isAbsolute(target)) {
        throw new Error(
          `${purpose} symlink escapes candidate in ${index.indexPath}: ${selectedPath} -> ${target}`,
        );
      }
      const activeSymlink = { path: selectedPath, target };
      activePaths.add(selectedPath);
      activeSymlinks.push(activeSymlink);
      segments.pop();
      pending.unshift(...target.split('/'), { completedSymlink: selectedPath });
      continue;
    }
    if (entry !== undefined) {
      // Proof: returning the selected file before examining remaining components made both
      // `docs/guide.md/../guide.md` CLIs exit 0 (Markdown link and member-symlink target;
      // both expected exit 1, both received 0).
      if (hasPendingPathComponent(pending)) {
        throw new Error(
          `${purpose} ${purpose === 'membership' ? 'symlink ' : ''}path component is not a directory in ${index.indexPath}: ${selectedPath}`,
        );
      }
      return selectedPath;
    }
    if (!isCandidateDirectory(selectedPath, candidatePaths)) {
      const activeSymlink = activeSymlinks.at(-1);
      if (purpose === 'membership' && activeSymlink !== undefined) {
        // Proof: omitting this member boundary changed `missing -> not-selected` into the
        // unrelated `Markdown path absent ... not-selected` diagnostic.
        throw new Error(
          `membership symlink target absent in ${index.indexPath}: ${activeSymlink.path} -> ${activeSymlink.target}`,
        );
      }
      return exactCandidatePath(index.indexPath, selectedPath, candidatePaths);
    }
  }
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
    const requested = canonicalLinkPath(index, destination.path);
    const target = resolveSelectedPath(
      index,
      index.directory,
      destination.path,
      'Markdown',
      entries,
      candidatePaths,
      bytes,
    );
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
      return canonicalLinkPath(index, decoded.path) === proposal;
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
    const consumers = externalConsumers(index, members, candidatePaths);
    checkLinks(index, entries, candidatePaths, read.bytes);
    checkArchiveEntrypoints(index, members);
    return {
      indexPath: index.indexPath,
      moduleId: index.metadata.moduleId,
      identity: index.identity,
      members,
      externalConsumers: consumers,
      applicableChecks: index.metadata.applicableChecks,
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
