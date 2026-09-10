import { Buffer } from 'node:buffer';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const GitObjectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GitEntryPattern =
  /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;
// Proof: removing `ignoreBOM` made the exact candidate CLI return both `name` and `\uFEFFname`
// as `name`; the BOM-path test failed on the second tuple's path.
const Utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type CandidateRequest =
  | { kind: 'committed'; revision: string }
  | { kind: 'staged'; base: string }
  | { kind: 'working'; base: string };

export type CandidateSelection =
  | { kind: 'committed'; revision: string; tree: string }
  | { kind: 'staged'; base: string; indexTree: string }
  | { kind: 'working'; base: string; trackedSnapshot: string; untrackedSnapshot: string };

export interface CandidateEntry {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string;
}

export interface CandidateSnapshot {
  selection: CandidateSelection;
  entries: CandidateEntry[];
  untracked: string[];
}

export type CandidateReadFailure =
  | 'absent-index'
  | 'absent-revision'
  | 'index-changed'
  | 'malformed-git-output'
  | 'malformed-index'
  | 'not-repository'
  | 'unreadable-index'
  | 'working-tree-changed';

/** A fail-closed candidate boundary with a stable machine-readable failure category. */
export class CandidateReadError extends Error {
  constructor(
    readonly failure: CandidateReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CandidateReadError';
  }
}

interface GitInvocation {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

function invokeGit(
  repository: string,
  argv: string[],
  env?: Record<string, string | undefined>,
): GitInvocation {
  let invocation: ReturnType<typeof Bun.spawnSync>;
  try {
    invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
      env: env === undefined ? process.env : { ...process.env, ...env },
      stderr: 'pipe',
      stdout: 'pipe',
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CandidateReadError('not-repository', `not a readable Git repository: ${detail}`);
  }
  if (invocation.stdout === undefined || invocation.stderr === undefined) {
    throw new CandidateReadError(
      'malformed-git-output',
      'Git invocation did not expose the requested output pipes',
    );
  }
  return {
    exitCode: invocation.exitCode,
    stdout: invocation.stdout,
    stderr: invocation.stderr.toString('utf8').trim(),
  };
}

function readText(
  invocation: GitInvocation,
  failure: CandidateReadFailure,
  context: string,
): string {
  if (invocation.exitCode !== 0) {
    const detail =
      invocation.stderr.length === 0
        ? `git exited ${String(invocation.exitCode)}`
        : invocation.stderr;
    throw new CandidateReadError(failure, `${context}: ${detail}`);
  }
  try {
    return Utf8.decode(invocation.stdout).trim();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CandidateReadError('malformed-git-output', `${context}: non-UTF-8 output: ${detail}`);
  }
}

function resolveWorktreeRoot(repository: string): string {
  const invocation = invokeGit(repository, ['rev-parse', '--show-toplevel']);
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.length === 0 ? 'Git worktree unavailable' : invocation.stderr;
    throw new CandidateReadError('not-repository', `not a readable Git repository: ${detail}`);
  }
  return readText(invocation, 'not-repository', 'cannot resolve Git worktree root');
}

function resolveCommit(repository: string, revision: string, label: string): string {
  const invocation = invokeGit(repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revision}^{commit}`,
  ]);
  const commit = readText(invocation, 'absent-revision', `absent ${label} revision ${revision}`);
  if (!GitObjectIdPattern.test(commit)) {
    throw new CandidateReadError(
      'malformed-git-output',
      `malformed Git object identity for ${label} revision: ${commit}`,
    );
  }
  return commit;
}

function resolveTree(repository: string, commit: string): string {
  const tree = readText(
    invokeGit(repository, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]),
    'malformed-git-output',
    `cannot resolve tree for committed revision ${commit}`,
  );
  if (!GitObjectIdPattern.test(tree)) {
    throw new CandidateReadError(
      'malformed-git-output',
      `malformed Git tree identity for committed revision ${commit}: ${tree}`,
    );
  }
  return tree;
}

function resolveIndexPath(repository: string): string {
  const path = readText(
    invokeGit(repository, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    'not-repository',
    'cannot locate required Git index',
  );
  return isAbsolute(path) ? path : resolve(repository, path);
}

function readErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' ? code : undefined;
}

function captureIndex(repository: string, selection: 'staged' | 'working'): Buffer {
  const indexPath = resolveIndexPath(repository);
  let descriptor: number;
  try {
    descriptor = openSync(indexPath, 'r');
  } catch (cause) {
    if (readErrorCode(cause) === 'ENOENT') {
      // Proof: removing the required-index boundary let the absent-index CLI fixture select Git's
      // empty tree and exit 0; the after-capture removal fixture also reaches this exact refusal.
      throw new CandidateReadError(
        'absent-index',
        `absent required Git index during ${selection} selection: ${indexPath}`,
      );
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: classifying this branch as malformed made the production CLI unreadable-index
    // fixture fail on `Expected to contain: "unreadable required Git index"` after EACCES.
    throw new CandidateReadError('unreadable-index', `unreadable required Git index: ${detail}`);
  }
  try {
    return readFileSync(descriptor);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CandidateReadError('unreadable-index', `unreadable required Git index: ${detail}`);
  } finally {
    closeSync(descriptor);
  }
}

function parseEntries(bytes: Uint8Array, tree: string): CandidateEntry[] {
  // Proof: the production CLI wrapper injected unterminated, separatorless, bad-header and
  // mode/type-conflicting ls-tree records; the malformed-output test observed each named refusal.
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) {
    throw new CandidateReadError(
      'malformed-git-output',
      `malformed git ls-tree output for ${tree}: missing NUL terminator`,
    );
  }
  const entries: CandidateEntry[] = [];
  let start = 0;
  for (let cursor = 0; cursor < bytes.length; cursor += 1) {
    if (bytes[cursor] !== 0) continue;
    const record = bytes.subarray(start, cursor);
    start = cursor + 1;
    const separator = record.indexOf(9);
    if (separator < 0) {
      throw new CandidateReadError(
        'malformed-git-output',
        `malformed git ls-tree output for ${tree}: entry has no path separator`,
      );
    }
    let header: string;
    let path: string;
    try {
      header = Utf8.decode(record.subarray(0, separator));
      path = Utf8.decode(record.subarray(separator + 1));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new CandidateReadError(
        'malformed-git-output',
        `malformed git ls-tree output for ${tree}: non-UTF-8 entry: ${detail}`,
      );
    }
    const fields = GitEntryPattern.exec(header);
    if (fields === null || path.length === 0) {
      throw new CandidateReadError(
        'malformed-git-output',
        `malformed git ls-tree output for ${tree}: ${header}`,
      );
    }
    const mode = fields[1];
    const objectType = fields[2];
    const blob = fields[3];
    if ((mode === '160000') !== (objectType === 'commit')) {
      throw new CandidateReadError(
        'malformed-git-output',
        `malformed git ls-tree object kind for ${path}: ${header}`,
      );
    }
    if (mode !== '100644' && mode !== '100755' && mode !== '120000' && mode !== '160000') {
      throw new CandidateReadError(
        'malformed-git-output',
        `unsupported Git mode for ${path}: ${mode}`,
      );
    }
    entries.push({ path, mode, blob });
  }
  return entries;
}

function readTree(repository: string, tree: string): CandidateEntry[] {
  const invocation = invokeGit(repository, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  // Proof: replacing this failure-and-parse boundary with `return []` made the failed ls-tree
  // CLI fixture exit 0 with `entries: []` (expected exit 1).
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.length === 0 ? 'Git refused the tree' : invocation.stderr;
    throw new CandidateReadError(
      'malformed-git-output',
      `cannot read immutable Git tree ${tree}: ${detail}`,
    );
  }
  return parseEntries(invocation.stdout, tree);
}

function writeIndexTree(repository: string, env?: Record<string, string | undefined>): string {
  const invocation = invokeGit(repository, ['write-tree'], env);
  // Proof: substituting Git's empty tree for a failed write made the malformed-index CLI
  // fixture exit 0 with `entries: []` (expected exit 1).
  const tree = readText(invocation, 'malformed-index', 'malformed required Git index');
  if (!GitObjectIdPattern.test(tree)) {
    throw new CandidateReadError(
      'malformed-git-output',
      `malformed Git index tree identity: ${tree}`,
    );
  }
  return tree;
}

function writeCapturedIndexTree(repository: string, index: Uint8Array): string {
  const scratch = mkdtempSync(join(tmpdir(), 'tool-wiki-captured-index-'));
  const snapshotIndex = join(scratch, 'index');
  try {
    writeFileSync(snapshotIndex, index, { mode: 0o600 });
    return writeIndexTree(repository, { GIT_INDEX_FILE: snapshotIndex });
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

function readUntracked(repository: string): string[] {
  const invocation = invokeGit(repository, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (invocation.exitCode !== 0) {
    const detail =
      invocation.stderr.length === 0 ? 'Git refused the working tree' : invocation.stderr;
    throw new CandidateReadError(
      'working-tree-changed',
      `cannot read working untracked paths: ${detail}`,
    );
  }
  if (invocation.stdout.length === 0) return [];
  if (invocation.stdout.at(-1) !== 0) {
    throw new CandidateReadError(
      'malformed-git-output',
      'malformed untracked path output: missing NUL terminator',
    );
  }
  const paths: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor < invocation.stdout.length; cursor += 1) {
    if (invocation.stdout[cursor] !== 0) continue;
    let path: string;
    try {
      path = Utf8.decode(invocation.stdout.subarray(start, cursor));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new CandidateReadError('malformed-git-output', `non-UTF-8 untracked path: ${detail}`);
    }
    // Proof: removing this refusal made the malformed-untracked CLI fixture exit 0 with
    // `untracked: [""]` after Git emitted a single NUL record (expected exit 1).
    if (path.length === 0) {
      throw new CandidateReadError(
        'malformed-git-output',
        'malformed untracked path output: empty path record',
      );
    }
    paths.push(path);
    start = cursor + 1;
  }
  return paths;
}

type ManifestValue = string | ManifestValue[] | { [key: string]: ManifestValue };

function serializeCanonical(value: ManifestValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((element) => serializeCanonical(element)).join(',')}]`;
  }
  const fields = Object.entries(value).sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return `{${fields
    .map(([key, field]) => `${JSON.stringify(key)}:${serializeCanonical(field)}`)
    .join(',')}}`;
}

function hashManifest(value: ManifestValue): string {
  // Proof: replacing canonical serialization with insertion-order JSON made the production CLI
  // emit tracked hash 4db8d6... instead of the pinned da04baf... (expected exact match).
  return new Bun.CryptoHasher('sha256').update(`${serializeCanonical(value)}\n`).digest('hex');
}

function hashEntries(entries: CandidateEntry[]): string {
  return hashManifest(entries.map(({ blob, mode, path }) => ({ blob, mode, path })));
}

function snapshotWorkingTree(repository: string, indexTree: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'tool-wiki-working-index-'));
  const snapshotIndex = join(scratch, 'index');
  const env = { GIT_INDEX_FILE: snapshotIndex };
  try {
    readText(
      invokeGit(repository, ['read-tree', indexTree], env),
      'malformed-index',
      `cannot seed tracked working snapshot from index tree ${indexTree}`,
    );
    readText(
      invokeGit(repository, ['add', '--update', '--', '.'], env),
      'working-tree-changed',
      'cannot freeze tracked working bytes',
    );
    return writeIndexTree(repository, env);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

function readCommitted(repository: string, revision: string): CandidateSnapshot {
  const commit = resolveCommit(repository, revision, 'committed');
  const tree = resolveTree(repository, commit);
  return {
    selection: { kind: 'committed', revision: commit, tree },
    entries: readTree(repository, tree),
    untracked: [],
  };
}

function readStaged(repository: string, baseRevision: string): CandidateSnapshot {
  const base = resolveCommit(repository, baseRevision, 'staged base');
  const index = captureIndex(repository, 'staged');
  const indexTree = writeCapturedIndexTree(repository, index);
  const entries = readTree(repository, indexTree);
  // Proof: removing this recapture made the index-removal CLI fixture exit 0 with the captured
  // tree after `.git/index` disappeared (expected exit 1).
  const verifiedIndex = captureIndex(repository, 'staged');
  if (!verifiedIndex.equals(index)) {
    throw new CandidateReadError(
      'index-changed',
      'Git index changed while selecting staged candidate',
    );
  }
  return { selection: { kind: 'staged', base, indexTree }, entries, untracked: [] };
}

function readWorking(repository: string, baseRevision: string): CandidateSnapshot {
  const base = resolveCommit(repository, baseRevision, 'working base');
  const index = captureIndex(repository, 'working');
  const indexTree = writeCapturedIndexTree(repository, index);
  const firstTree = snapshotWorkingTree(repository, indexTree);
  const firstUntracked = readUntracked(repository);
  const entries = readTree(repository, firstTree);
  const verifiedTree = snapshotWorkingTree(repository, indexTree);
  const verifiedUntracked = readUntracked(repository);
  const verifiedIndex = captureIndex(repository, 'working');
  // Proof: removing this comparison made the working half of the CLI index-race fixture exit 0
  // with the stale tracked snapshot (expected exit 1).
  if (!verifiedIndex.equals(index)) {
    throw new CandidateReadError(
      'index-changed',
      'Git index changed while selecting working candidate',
    );
  }
  // Proof: removing this comparison made the tracked-working-byte race fixture exit 0 with
  // the first snapshot after the file changed (expected exit 1).
  if (verifiedTree !== firstTree) {
    throw new CandidateReadError(
      'working-tree-changed',
      'working tree changed while selecting diagnostic candidate',
    );
  }
  // Proof: removing only this comparison made the untracked-membership race CLI fixture exit 0
  // with `first-untracked.txt` and `git-wrapper/git`, omitting the later path (expected exit 1).
  if (hashManifest(verifiedUntracked) !== hashManifest(firstUntracked)) {
    throw new CandidateReadError(
      'working-tree-changed',
      'working tree changed while selecting diagnostic candidate',
    );
  }
  return {
    selection: {
      kind: 'working',
      base,
      trackedSnapshot: hashEntries(entries),
      untrackedSnapshot: hashManifest(firstUntracked),
    },
    entries,
    untracked: firstUntracked,
  };
}

/**
 * Freezes one explicit Git candidate selection and returns its exact tracked tuples.
 * Working selections are diagnostic snapshots and keep untracked paths outside the tuple set.
 * @throws {@link CandidateReadError} when required Git state cannot be selected completely.
 */
export function readCandidate(repository: string, request: CandidateRequest): CandidateSnapshot {
  const root = resolveWorktreeRoot(repository);
  switch (request.kind) {
    case 'committed':
      return readCommitted(root, request.revision);
    case 'staged':
      return readStaged(root, request.base);
    case 'working':
      // Proof: passing the caller's interior directory here left the root tracked blob stale and
      // returned only `nested-new.txt`; the production CLI expected both root-relative additions.
      return readWorking(root, request.base);
  }
}
