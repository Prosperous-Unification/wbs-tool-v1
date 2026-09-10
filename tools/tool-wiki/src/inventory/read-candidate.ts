import { accessSync, closeSync, constants, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const GitObjectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GitEntryPattern =
  /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/;
const Utf8 = new TextDecoder('utf-8', { fatal: true });

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

function assertRepository(repository: string): void {
  const invocation = invokeGit(repository, ['rev-parse', '--git-dir']);
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.length === 0 ? 'git directory unavailable' : invocation.stderr;
    throw new CandidateReadError('not-repository', `not a readable Git repository: ${detail}`);
  }
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

function assertReadableIndex(repository: string): void {
  const indexPath = resolveIndexPath(repository);
  try {
    statSync(indexPath);
  } catch (cause) {
    if (readErrorCode(cause) === 'ENOENT') {
      throw new CandidateReadError('absent-index', `absent required Git index: ${indexPath}`);
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new CandidateReadError('unreadable-index', `unreadable required Git index: ${detail}`);
  }

  try {
    accessSync(indexPath, constants.R_OK);
    const descriptor = openSync(indexPath, 'r');
    closeSync(descriptor);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: classifying this branch as malformed made the production CLI unreadable-index
    // fixture fail on `Expected to contain: "unreadable required Git index"` after EACCES.
    throw new CandidateReadError('unreadable-index', `unreadable required Git index: ${detail}`);
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
    try {
      paths.push(Utf8.decode(invocation.stdout.subarray(start, cursor)));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new CandidateReadError('malformed-git-output', `non-UTF-8 untracked path: ${detail}`);
    }
    start = cursor + 1;
  }
  return paths;
}

function hashManifest(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
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
  // Proof: removing this preflight made the absent-index CLI fixture exit 0 with the empty
  // tree `4b825d...`, entries [], instead of failing as required.
  assertReadableIndex(repository);
  const indexTree = writeIndexTree(repository);
  const entries = readTree(repository, indexTree);
  const verifiedTree = writeIndexTree(repository);
  // Proof: removing this comparison made the CLI race fixture exit 0 with the first index tree;
  // `refuses an index change while the staged candidate is being read` expected exit 1.
  if (verifiedTree !== indexTree) {
    throw new CandidateReadError(
      'index-changed',
      `Git index changed while selecting staged candidate: ${indexTree} became ${verifiedTree}`,
    );
  }
  return { selection: { kind: 'staged', base, indexTree }, entries, untracked: [] };
}

function readWorking(repository: string, baseRevision: string): CandidateSnapshot {
  const base = resolveCommit(repository, baseRevision, 'working base');
  assertReadableIndex(repository);
  const indexTree = writeIndexTree(repository);
  const firstTree = snapshotWorkingTree(repository, indexTree);
  const firstUntracked = readUntracked(repository);
  const entries = readTree(repository, firstTree);
  const verifiedTree = snapshotWorkingTree(repository, indexTree);
  const verifiedUntracked = readUntracked(repository);
  const verifiedIndexTree = writeIndexTree(repository);
  // Proof: removing this comparison made the working half of the CLI index-race fixture exit 0
  // with the stale tracked snapshot (expected exit 1).
  if (verifiedIndexTree !== indexTree) {
    throw new CandidateReadError(
      'index-changed',
      `Git index changed while selecting working candidate: ${indexTree} became ${verifiedIndexTree}`,
    );
  }
  // Proof: removing this comparison made the tracked-working-byte race fixture exit 0 with
  // the first snapshot after the file changed (expected exit 1).
  if (
    verifiedTree !== firstTree ||
    hashManifest(verifiedUntracked) !== hashManifest(firstUntracked)
  ) {
    throw new CandidateReadError(
      'working-tree-changed',
      'working tree changed while selecting diagnostic candidate',
    );
  }
  return {
    selection: {
      kind: 'working',
      base,
      trackedSnapshot: hashManifest(entries),
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
  assertRepository(repository);
  switch (request.kind) {
    case 'committed':
      return readCommitted(repository, request.revision);
    case 'staged':
      return readStaged(repository, request.base);
    case 'working':
      return readWorking(repository, request.base);
  }
}
