import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

export const AUTHORITY_SCHEMA_VERSION = 'wbs-wiki-authority.v2' as const;

export type PathAccess = 'read' | 'write';

export interface PathClaim {
  readonly kind: 'path';
  readonly identity: string;
  readonly access: PathAccess;
}

export interface GroupClaim {
  readonly kind: 'group';
  readonly identity: string;
}

export type AuthorityClaim = PathClaim | GroupClaim;

export type GenerationStatus =
  'working' | 'investigating' | 'submitted' | 'integrated' | 'rejected' | 'abandoned' | 'released';

export interface SubmissionIdentity {
  readonly patchIdentity: string;
  readonly candidateDiffIdentity: string;
  readonly contentIdentity: string;
}

export interface AuthorityGeneration {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly claims: readonly AuthorityClaim[];
  readonly status: GenerationStatus;
  readonly heartbeatAt: number;
  readonly statusAt: number;
  readonly submission?: SubmissionIdentity;
}

export interface AuthorityState {
  readonly nextGeneration: number;
  readonly generations: readonly AuthorityGeneration[];
}

/**
 * Trusted epoch-millisecond source configured with the adapter, never supplied by a claimant.
 *
 * Wall clocks are not claimed monotonic across processes; persisted regressions are refused.
 */
export interface AuthorityClock {
  read(): number;
}

function assertAuthorityClock(clock: unknown): asserts clock is AuthorityClock {
  // Proof: before this boundary, `{clock:{}}` constructed live memory and SQLite stores; their
  // malformed-clock adapter tests observed that neither constructor threw.
  if (
    typeof clock !== 'object' ||
    clock === null ||
    !('read' in clock) ||
    typeof clock.read !== 'function'
  ) {
    throw new Error('invalid authority clock adapter');
  }
}

/**
 * The synchronous mutation surface held inside one authority transaction.
 *
 * The callback shape makes the conflict read, generation allocation, owner insert and claim
 * inserts one indivisible operation. A caller cannot retain this view after the callback returns.
 * See {@link ../../../docs/adr/0021-shared-git-admission-authority.md Shared Git admission authority}.
 */
export interface AuthorityTransaction {
  readState(): AuthorityState;
  writeState(state: AuthorityState): void;
}

/**
 * One common-Git authority store; adapters must commit the callback or leave no mutation.
 *
 * An adapter may invoke `operation` again after rolling back retryable contention, including
 * contention raised by the body or commit. Callbacks must therefore be synchronous,
 * deterministic and free of effects outside the supplied transaction. A callback value is
 * returned only after its transaction commits.
 */
export interface AuthorityStore {
  transact<T>(operation: (transaction: AuthorityTransaction) => T): T;
  readClock(): number;
}

function copyClaim(claim: AuthorityClaim): AuthorityClaim {
  return claim.kind === 'path'
    ? { access: claim.access, identity: claim.identity, kind: 'path' }
    : { identity: claim.identity, kind: 'group' };
}

function copyState(state: AuthorityState): AuthorityState {
  return {
    nextGeneration: state.nextGeneration,
    generations: state.generations.map((generation) => ({
      claims: generation.claims.map(copyClaim),
      generation: generation.generation,
      heartbeatAt: generation.heartbeatAt,
      sessionId: generation.sessionId,
      status: generation.status,
      statusAt: generation.statusAt,
      submission: generation.submission === undefined ? undefined : { ...generation.submission },
      worktreePath: generation.worktreePath,
    })),
  };
}

function assertSynchronous(value: unknown): void {
  // Proof: without this boundary an async callback returned a resolved Promise and committed its
  // pending state; the callback-contract test observed that `transact` did not throw.
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value
  ) {
    throw new Error('authority transaction callback must be synchronous');
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const HOLDING_STATUSES: ReadonlySet<GenerationStatus> = new Set([
  'working',
  'investigating',
  'submitted',
]);

/** Refuses a persisted or requested submission identity outside the exact SHA-256 contract. */
export function assertSubmissionIdentity(submission: SubmissionIdentity): void {
  // Proof: weakening the SHA-256 matcher to accept every string let `not-sha256` publish; the
  // malformed-submission production test observed that `submitGeneration` did not throw for each
  // of patch, candidate-diff and content identity.
  if (!SHA256.test(submission.patchIdentity)) throw new Error('invalid patch identity');
  if (!SHA256.test(submission.candidateDiffIdentity)) {
    throw new Error('invalid candidate diff identity');
  }
  if (!SHA256.test(submission.contentIdentity)) throw new Error('invalid content identity');
}

/** Refuses a time value that cannot be represented identically by memory and SQLite. */
export function assertAuthorityTimestamp(timestamp: number): void {
  // Proof: bypassing this boundary made -1 reach the later regression diagnostic rather than the
  // canonical timestamp boundary; the production heartbeat test lost its exact refusal.
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`invalid authority clock timestamp: ${String(timestamp)}`);
  }
}

function assertMemoryState(state: AuthorityState): void {
  if (!Number.isSafeInteger(state.nextGeneration) || state.nextGeneration < 1) {
    throw new Error('invalid memory authority next generation');
  }
  const activeSessions = new Set<string>();
  const generations = new Set<number>();
  let highestGeneration = 0;
  for (const record of state.generations) {
    assertAuthoritySessionId(record.sessionId);
    assertAuthorityWorktreePath(record.worktreePath);
    if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
      throw new Error(`invalid authority generation for session ${record.sessionId}`);
    }
    if (generations.has(record.generation)) {
      throw new Error(`duplicate authority generation: ${String(record.generation)}`);
    }
    generations.add(record.generation);
    highestGeneration = Math.max(highestGeneration, record.generation);
    assertGenerationStatus(record.status);
    assertAuthorityTimestamp(record.heartbeatAt);
    assertAuthorityTimestamp(record.statusAt);
    // Proof: removing this ordering check let status time 999 follow heartbeat 1000; the malformed-
    // lifecycle test observed that `MemoryAuthorityStore` constructed successfully.
    if (record.statusAt < record.heartbeatAt) {
      throw new Error(`authority generation status predates heartbeat: ${record.sessionId}`);
    }
    if (HOLDING_STATUSES.has(record.status)) {
      // Proof: removing this check let two live generations for session-a construct; the malformed-
      // lifecycle test observed that `MemoryAuthorityStore` did not throw.
      if (activeSessions.has(record.sessionId)) {
        throw new Error(`duplicate active authority session: ${record.sessionId}`);
      }
      activeSessions.add(record.sessionId);
      // Proof: removing this terminal-state check let an integrated generation retain its write
      // claim; the malformed-lifecycle test observed that the memory authority did not throw.
    } else if (record.claims.length !== 0) {
      throw new Error(`terminal authority generation retains claims: ${record.sessionId}`);
    }
    if (record.submission !== undefined) assertSubmissionIdentity(record.submission);
    const requiresSubmission = record.status === 'submitted' || record.status === 'integrated';
    const forbidsSubmission =
      record.status === 'working' ||
      record.status === 'investigating' ||
      record.status === 'released';
    // Proof: bypassing each half separately let either a `submitted` record omit identities or a
    // `released` record retain them; the malformed-lifecycle test observed successful construction.
    if (
      (requiresSubmission && record.submission === undefined) ||
      (forbidsSubmission && record.submission !== undefined)
    ) {
      throw new Error(`authority generation submission does not match status: ${record.sessionId}`);
    }
    for (const claim of record.claims) {
      if (claim.kind === 'path') {
        assertAuthorityClaimPath(claim.identity);
        assertAuthorityPathAccess(claim.access);
      } else {
        assertAuthorityConflictGroup(claim.identity);
      }
    }
  }
  // Proof: removing this ordering check let a state whose next generation was already owned
  // construct successfully; the memory-state test observed no throw.
  if (state.nextGeneration <= highestGeneration) {
    throw new Error('authority next generation does not follow existing generations');
  }
}

/** In-memory adapter with the same commit-or-rollback callback semantics as SQLite. */
export class MemoryAuthorityStore implements AuthorityStore {
  #state: AuthorityState;
  readonly #clock: AuthorityClock;

  constructor(
    initial: AuthorityState = { generations: [], nextGeneration: 1 },
    clock: AuthorityClock = { read: () => Date.now() },
  ) {
    assertMemoryState(initial);
    assertAuthorityClock(clock);
    this.#state = copyState(initial);
    this.#clock = clock;
  }

  transact<T>(operation: (transaction: AuthorityTransaction) => T): T {
    let pending = copyState(this.#state);
    const value = operation({
      readState: () => copyState(pending),
      writeState: (state) => {
        assertMemoryState(state);
        pending = copyState(state);
      },
    });
    assertSynchronous(value);
    this.#state = pending;
    return value;
  }

  /** A detached snapshot for assertions and diagnostics. */
  inspect(): AuthorityState {
    return copyState(this.#state);
  }

  readClock(): number {
    return this.#clock.read();
  }
}

const SCHEMA = [
  `CREATE TABLE authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version TEXT NOT NULL,
    next_generation INTEGER NOT NULL CHECK (next_generation >= 1)
  ) STRICT`,
  `CREATE TABLE authority_generation (
    session_id TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1),
    status TEXT NOT NULL CHECK (status IN ('working', 'investigating', 'submitted', 'integrated', 'rejected', 'abandoned', 'released')),
    heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= 0),
    status_at INTEGER NOT NULL CHECK (status_at >= heartbeat_at),
    patch_identity TEXT,
    candidate_diff_identity TEXT,
    content_identity TEXT,
    PRIMARY KEY (session_id, generation),
    CHECK ((patch_identity IS NULL AND candidate_diff_identity IS NULL AND content_identity IS NULL) OR (patch_identity IS NOT NULL AND candidate_diff_identity IS NOT NULL AND content_identity IS NOT NULL)),
    CHECK ((status IN ('submitted', 'integrated') AND patch_identity IS NOT NULL) OR (status IN ('working', 'investigating', 'released') AND patch_identity IS NULL) OR (status IN ('rejected', 'abandoned')))
  ) STRICT`,
  `CREATE TABLE authority_claim (
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'group')),
    access TEXT CHECK (access IN ('read', 'write')),
    identity TEXT NOT NULL,
    PRIMARY KEY (session_id, kind, identity),
    FOREIGN KEY (session_id, generation) REFERENCES authority_generation(session_id, generation) ON DELETE CASCADE,
    CHECK ((kind = 'path' AND access IS NOT NULL) OR (kind = 'group' AND access IS NULL))
  ) STRICT`,
] as const;

const DEFAULT_BUSY_ATTEMPTS = 50;
const DEFAULT_BUSY_DELAY_MS = 5;
const MAX_BUSY_ATTEMPTS = 100;
const MAX_BUSY_DELAY_MS = 50;

export interface AuthorityStoreOptions {
  readonly maxBusyAttempts?: number;
  readonly busyDelayMilliseconds?: number;
  readonly clock?: unknown;
}

interface RequiredAuthorityStoreOptions {
  readonly maxBusyAttempts: number;
  readonly busyDelayMilliseconds: number;
  readonly clock: AuthorityClock;
}

interface SchemaRow {
  readonly name: string;
  readonly sql: string;
  readonly type: string;
}

interface MetaRow {
  readonly schemaVersion: string;
  readonly nextGeneration: number;
}

interface GenerationRow {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly status: string;
  readonly heartbeatAt: number;
  readonly statusAt: number;
  readonly patchIdentity: string | null;
  readonly candidateDiffIdentity: string | null;
  readonly contentIdentity: string | null;
}

interface ClaimRow {
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: string;
  readonly access: string | null;
  readonly identity: string;
}

function assertGenerationStatus(status: string): asserts status is GenerationStatus {
  if (
    status === 'working' ||
    status === 'investigating' ||
    status === 'submitted' ||
    status === 'integrated' ||
    status === 'rejected' ||
    status === 'abandoned' ||
    status === 'released'
  ) {
    return;
  }
  // Proof: before this runtime boundary, a memory record with status `unknown` constructed
  // successfully; the malformed-lifecycle test observed that the constructor did not throw.
  throw new Error(`invalid authority generation status: ${status}`);
}

function decodeGenerationStatus(status: string): GenerationStatus {
  try {
    assertGenerationStatus(status);
  } catch (cause) {
    throw new Error(`authority database generation status is invalid: ${status}`, { cause });
  }
  return status;
}

/** The authority exhausted its configured attempts to take SQLite's write lock. */
export class AuthorityContentionError extends Error {
  constructor(attempts: number, cause?: unknown) {
    super(
      `authority database remained busy after ${String(attempts)} attempts`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'AuthorityContentionError';
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function isBusy(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    // Proof: refusing to classify the SQLite code leaked raw `database is locked`; the bounded
    // contention test expected `AuthorityContentionError` from the production acquire path.
    if ('code' in current && (current.code === 'SQLITE_BUSY' || current.code === 'SQLITE_LOCKED')) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GROUP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function containsControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

/** Refuses a session identity that cannot be persisted as one authority owner. */
export function assertAuthoritySessionId(sessionId: string): void {
  if (!SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

/** Refuses a worktree identity that is not already absolute and lexically canonical. */
export function assertAuthorityWorktreePath(worktreePath: string): void {
  if (
    !isAbsolute(worktreePath) ||
    normalize(worktreePath) !== worktreePath ||
    containsControl(worktreePath) ||
    worktreePath.includes('\\')
  ) {
    throw new Error(`invalid canonical worktree path: ${worktreePath}`);
  }
}

/** Refuses a repository-relative path identity that would require normalization. */
export function assertAuthorityClaimPath(path: string): void {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    containsControl(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid canonical claim path: ${path}`);
  }
}

/** Refuses a conflict group that is not a finite authority identity. */
export function assertAuthorityConflictGroup(identity: string): void {
  if (!GROUP.test(identity)) throw new Error(`invalid conflict group: ${identity}`);
}

/** Refuses a runtime path access outside the closed read/write domain. */
export function assertAuthorityPathAccess(access: string): asserts access is PathAccess {
  if (access !== 'read' && access !== 'write') {
    throw new Error(`invalid path access: ${access}`);
  }
}

function requiredOptions(options: AuthorityStoreOptions): RequiredAuthorityStoreOptions {
  const maxBusyAttempts = options.maxBusyAttempts ?? DEFAULT_BUSY_ATTEMPTS;
  const busyDelayMilliseconds = options.busyDelayMilliseconds ?? DEFAULT_BUSY_DELAY_MS;
  let clock = options.clock;
  if (clock === undefined) clock = { read: () => Date.now() };
  assertAuthorityClock(clock);
  // Proof: before these ceilings, attempts 1001 constructed a live store; the finite-budget test
  // observed that the constructor did not throw.
  if (
    !Number.isSafeInteger(maxBusyAttempts) ||
    maxBusyAttempts < 1 ||
    maxBusyAttempts > MAX_BUSY_ATTEMPTS
  ) {
    throw new Error(`invalid authority busy attempt bound: ${String(maxBusyAttempts)}`);
  }
  if (
    !Number.isSafeInteger(busyDelayMilliseconds) ||
    busyDelayMilliseconds < 0 ||
    // Proof: without the delay ceiling, 1001 ms constructed a live store; the finite-budget
    // test observed that the constructor did not throw.
    busyDelayMilliseconds > MAX_BUSY_DELAY_MS
  ) {
    throw new Error(`invalid authority busy delay: ${String(busyDelayMilliseconds)}`);
  }
  return {
    busyDelayMilliseconds,
    clock,
    maxBusyAttempts,
  };
}

function runGitCommonDirectory(worktreePath: string): string {
  const invocation = Bun.spawnSync(['git', '-C', worktreePath, 'rev-parse', '--git-common-dir'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = new TextDecoder().decode(invocation.stderr).trim();
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot resolve common Git directory for ${worktreePath}: ${stderr || `exit ${String(invocation.exitCode)}`}`,
    );
  }
  const stdout = new TextDecoder().decode(invocation.stdout);
  if (stdout.includes('\u0000')) throw new Error('common Git directory output contains NUL');
  const lines = stdout.trimEnd().split('\n');
  if (lines.length !== 1 || lines[0]?.length === 0) {
    throw new Error(`git returned malformed common directory for ${worktreePath}`);
  }
  const common = lines[0];
  return realpathSync(isAbsolute(common) ? common : resolve(worktreePath, common));
}

/** Resolves the one authority file shared by every linked or symlinked worktree. */
export function resolveAuthorityDatabasePath(worktreePath: string): string {
  const commonDirectory = runGitCommonDirectory(worktreePath);
  const authorityDirectory = join(commonDirectory, 'wbs-wiki');
  mkdirSync(authorityDirectory, { recursive: true });
  // Proof: omitting this comparison let `.git/wbs-wiki` redirect the authority outside the
  // common Git directory; the symlink test observed that resolution did not throw.
  if (realpathSync(authorityDirectory) !== authorityDirectory) {
    throw new Error(`authority directory is not canonical: ${authorityDirectory}`);
  }
  return join(authorityDirectory, 'authority.sqlite');
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function assertSchema(database: Database): void {
  const quick = database.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
  // Proof: persisted unknown status, regressed status time and integrated-without-submission faults
  // each made the SQLite lifecycle test observe this production open refuse as corrupt.
  if (quick?.quick_check !== 'ok') {
    throw new Error(`authority database corrupt: quick_check=${quick?.quick_check ?? 'missing'}`);
  }
  const foreignKeyFaults = database
    .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
    .all();
  // Proof: omitting this check let an orphan `libs/contracts` claim open as healthy; the
  // relational-corruption test observed that `openAuthorityStore` did not throw.
  if (foreignKeyFaults.length !== 0) {
    throw new Error('authority database corrupt: foreign-key check failed');
  }
  // Proof: SQL LIKE treated `_` as a wildcard and hid `sqliteXerase`; the production schema
  // test observed that its trigger erased every claim instead of being refused.
  const rows = database
    .query<SchemaRow, []>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE substr(name, 1, 7) <> 'sqlite_'
       ORDER BY type, name`,
    )
    .all();
  const expected = SCHEMA.map((sql) => ({
    name: /^CREATE TABLE ([a-z_]+)/.exec(sql)?.[1] ?? '',
    sql: normalizedSql(sql),
    type: 'table',
  })).sort((left, right) => left.name.localeCompare(right.name));
  const actual = rows.map((row) => ({
    name: row.name,
    sql: normalizedSql(row.sql),
    type: row.type,
  }));
  // Proof: bypassing this comparison let an existing database with `foreign_state` open;
  // the strict-schema test observed that `openAuthorityStore` did not throw.
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('authority database schema is incompatible');
  }
  const meta = database
    .query<MetaRow, []>(
      `SELECT schema_version AS schemaVersion, next_generation AS nextGeneration
       FROM authority_meta WHERE singleton = 1`,
    )
    .get();
  // Proof: accepting any stored version let `unknown.v99` open; the version test observed that
  // `openAuthorityStore` did not throw.
  if (meta?.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error('authority database version is incompatible');
  }
  if (!Number.isSafeInteger(meta.nextGeneration) || meta.nextGeneration < 1) {
    throw new Error('authority database next generation is invalid');
  }
  // Proof: without decoding persisted identities here, `bad/session`, a relative worktree,
  // `libs/./contracts` and `bad/group` each opened as trusted state; the persisted-identity test
  // observed that `openAuthorityStore` did not throw.
  readSqliteState(database);
}

function assertSchemaWithRetry(database: Database, options: RequiredAuthorityStoreOptions): void {
  for (let attempt = 1; attempt <= options.maxBusyAttempts; attempt += 1) {
    try {
      // Proof: without this snapshot, a valid commit between the meta and owner reads produced
      // `authority next generation does not follow existing generations`; the two-store snapshot
      // test observed false corruption while both the preceding and following states were valid.
      database.run('BEGIN');
      assertSchema(database);
      database.run('COMMIT');
      return;
    } catch (cause) {
      rollbackTransaction(database, cause);
      if (!isBusy(cause)) throw cause;
      if (attempt === options.maxBusyAttempts) {
        throw new AuthorityContentionError(options.maxBusyAttempts, cause);
      }
      Bun.sleepSync(options.busyDelayMilliseconds);
    }
  }
}

function initializeDatabase(database: Database): void {
  database.run('BEGIN IMMEDIATE');
  try {
    for (const sql of SCHEMA) database.run(sql);
    database
      .query<never, [number, string, number]>(
        'INSERT INTO authority_meta(singleton, schema_version, next_generation) VALUES (?, ?, ?)',
      )
      .run(1, AUTHORITY_SCHEMA_VERSION, 1);
    database.run('COMMIT');
  } catch (error) {
    database.run('ROLLBACK');
    throw error;
  }
}

function openDatabase(
  databasePath: string,
  initialize: boolean,
  options: RequiredAuthorityStoreOptions,
): Database {
  let database: Database;
  try {
    database = new Database(databasePath, { create: initialize, strict: true });
  } catch (error) {
    throw new Error(
      `authority database unreadable: ${databasePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    database.run('PRAGMA foreign_keys = ON');
    database.run('PRAGMA busy_timeout = 0');
    const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    const busy = database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
    if (foreignKeys?.foreign_keys !== 1 || busy?.timeout !== 0) {
      throw new Error('authority database connection pragmas were not adopted');
    }
    if (initialize) initializeDatabase(database);
    assertSchemaWithRetry(database, options);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && error.message.startsWith('authority database')) throw error;
    throw new Error(
      `authority database corrupt or incompatible: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function waitForInitializer(initializerPath: string, options: RequiredAuthorityStoreOptions): void {
  for (let attempt = 1; attempt <= options.maxBusyAttempts; attempt += 1) {
    if (!existsSync(initializerPath)) return;
    if (attempt < options.maxBusyAttempts) Bun.sleepSync(options.busyDelayMilliseconds);
  }
  throw new AuthorityContentionError(options.maxBusyAttempts);
}

function connectAuthority(databasePath: string, options: RequiredAuthorityStoreOptions): Database {
  try {
    // Proof: omitting this check followed `authority.sqlite` to an external empty database; the
    // database-symlink test received a schema error instead of the canonical-location refusal.
    if (lstatSync(databasePath).isSymbolicLink()) {
      throw new Error(`authority database is not canonical: ${databasePath}`);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const initializerPath = `${databasePath}.initializing`;
  if (existsSync(databasePath)) {
    waitForInitializer(initializerPath, options);
    return openDatabase(databasePath, false, options);
  }
  try {
    mkdirSync(initializerPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    waitForInitializer(initializerPath, options);
    if (!existsSync(databasePath)) {
      throw new Error('authority initialization ended without a database', { cause: error });
    }
    return openDatabase(databasePath, false, options);
  }
  try {
    if (existsSync(databasePath)) return openDatabase(databasePath, false, options);
    return openDatabase(databasePath, true, options);
  } finally {
    rmdirSync(initializerPath);
  }
}

function readSqliteState(database: Database): AuthorityState {
  const meta = database
    .query<MetaRow, []>(
      'SELECT schema_version AS schemaVersion, next_generation AS nextGeneration FROM authority_meta WHERE singleton = 1',
    )
    .get();
  if (meta?.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error('authority database version is incompatible');
  }
  const generations = database
    .query<GenerationRow, []>(
      `SELECT session_id AS sessionId, worktree_path AS worktreePath, generation, status,
              heartbeat_at AS heartbeatAt, status_at AS statusAt,
              patch_identity AS patchIdentity, candidate_diff_identity AS candidateDiffIdentity,
              content_identity AS contentIdentity
       FROM authority_generation ORDER BY generation`,
    )
    .all();
  const claims = database
    .query<ClaimRow, []>(
      'SELECT session_id AS sessionId, generation, kind, access, identity FROM authority_claim ORDER BY identity, kind',
    )
    .all();
  const state: AuthorityState = {
    nextGeneration: meta.nextGeneration,
    generations: generations.map((record) => {
      try {
        assertAuthoritySessionId(record.sessionId);
      } catch (cause) {
        throw new Error(`authority database generation session is invalid: ${record.sessionId}`, {
          cause,
        });
      }
      try {
        assertAuthorityWorktreePath(record.worktreePath);
      } catch (cause) {
        throw new Error(
          `authority database generation worktree is invalid: ${record.worktreePath}`,
          {
            cause,
          },
        );
      }
      const submission =
        record.patchIdentity === null &&
        record.candidateDiffIdentity === null &&
        record.contentIdentity === null
          ? undefined
          : record.patchIdentity !== null &&
              record.candidateDiffIdentity !== null &&
              record.contentIdentity !== null
            ? {
                candidateDiffIdentity: record.candidateDiffIdentity,
                contentIdentity: record.contentIdentity,
                patchIdentity: record.patchIdentity,
              }
            : (() => {
                throw new Error(
                  `authority database generation has a partial submission: ${record.sessionId}/${String(record.generation)}`,
                );
              })();
      return {
        generation: record.generation,
        heartbeatAt: record.heartbeatAt,
        sessionId: record.sessionId,
        status: decodeGenerationStatus(record.status),
        statusAt: record.statusAt,
        submission,
        worktreePath: record.worktreePath,
        claims: claims
          .filter(
            (claim) =>
              claim.sessionId === record.sessionId && claim.generation === record.generation,
          )
          .map((claim): AuthorityClaim => {
            if (claim.kind === 'group' && claim.access === null) {
              try {
                assertAuthorityConflictGroup(claim.identity);
              } catch (cause) {
                throw new Error(`authority database conflict group is invalid: ${claim.identity}`, {
                  cause,
                });
              }
              return { identity: claim.identity, kind: 'group' };
            }
            if (claim.kind === 'path' && (claim.access === 'read' || claim.access === 'write')) {
              try {
                assertAuthorityClaimPath(claim.identity);
                assertAuthorityPathAccess(claim.access);
              } catch (cause) {
                throw new Error(`authority database path claim is invalid: ${claim.identity}`, {
                  cause,
                });
              }
              return { access: claim.access, identity: claim.identity, kind: 'path' };
            }
            throw new Error(
              `authority database claim is invalid: ${claim.sessionId}/${claim.identity}`,
            );
          }),
      };
    }),
  };
  assertMemoryState(state);
  if (
    claims.length !==
    state.generations.reduce((count, generation) => count + generation.claims.length, 0)
  ) {
    throw new Error('authority database contains a claim without its exact owner generation');
  }
  return state;
}

function writeSqliteState(database: Database, state: AuthorityState): void {
  assertMemoryState(state);
  database.run('DELETE FROM authority_claim');
  database.run('DELETE FROM authority_generation');
  database
    .query<never, [number]>('UPDATE authority_meta SET next_generation = ? WHERE singleton = 1')
    .run(state.nextGeneration);
  const insertGeneration = database.query<
    never,
    [
      string,
      string,
      number,
      GenerationStatus,
      number,
      number,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO authority_generation(
       session_id, worktree_path, generation, status, heartbeat_at, status_at,
       patch_identity, candidate_diff_identity, content_identity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClaim = database.query<never, [string, number, string, string | null, string]>(
    'INSERT INTO authority_claim(session_id, generation, kind, access, identity) VALUES (?, ?, ?, ?, ?)',
  );
  for (const generation of state.generations) {
    insertGeneration.run(
      generation.sessionId,
      generation.worktreePath,
      generation.generation,
      generation.status,
      generation.heartbeatAt,
      generation.statusAt,
      generation.submission?.patchIdentity ?? null,
      generation.submission?.candidateDiffIdentity ?? null,
      generation.submission?.contentIdentity ?? null,
    );
    for (const claim of generation.claims) {
      insertClaim.run(
        generation.sessionId,
        generation.generation,
        claim.kind,
        claim.kind === 'path' ? claim.access : null,
        claim.identity,
      );
    }
  }
}

function isTransactionOpen(database: Database): boolean {
  return database.inTransaction;
}

function rollbackTransaction(database: Database, transactionCause: unknown): void {
  if (!isTransactionOpen(database)) return;
  try {
    database.run('ROLLBACK');
    if (isTransactionOpen(database)) {
      throw new Error('authority database remained in a transaction after rollback');
    }
  } catch (rollbackCause) {
    // Proof: ignoring an injected rollback failure retried on the still-open transaction and
    // leaked `cannot start a transaction within a transaction`; the rollback-failure test
    // expected both original failures and exactly one callback attempt.
    throw new AggregateError(
      [transactionCause, rollbackCause],
      'authority transaction and rollback both failed',
      { cause: rollbackCause },
    );
  }
}

/** SQLite adapter for the canonical common-Git admission authority. */
class SqliteAuthorityStore implements AuthorityStore {
  readonly #database: Database;
  readonly #options: RequiredAuthorityStoreOptions;

  constructor(databasePath: string, options: AuthorityStoreOptions = {}) {
    this.#options = requiredOptions(options);
    this.#database = connectAuthority(databasePath, this.#options);
  }

  transact<T>(operation: (transaction: AuthorityTransaction) => T): T {
    for (let attempt = 1; attempt <= this.#options.maxBusyAttempts; attempt += 1) {
      try {
        this.#database.run('BEGIN IMMEDIATE');
        let pending = readSqliteState(this.#database);
        const value = operation({
          readState: () => copyState(pending),
          writeState: (state) => {
            assertMemoryState(state);
            pending = copyState(state);
          },
        });
        assertSynchronous(value);
        writeSqliteState(this.#database, pending);
        this.#database.run('COMMIT');
        return value;
      } catch (cause) {
        rollbackTransaction(this.#database, cause);
        // Proof: retrying only BEGIN leaked raw SQLITE_BUSY when a rollback-journal reader
        // blocked COMMIT; the reader tests observed one callback instead of the bounded attempt
        // count, no configured delay, and no convergence after the reader released.
        if (!isBusy(cause)) throw cause;
        if (attempt === this.#options.maxBusyAttempts) {
          throw new AuthorityContentionError(this.#options.maxBusyAttempts, cause);
        }
        Bun.sleepSync(this.#options.busyDelayMilliseconds);
      }
    }
    throw new AuthorityContentionError(this.#options.maxBusyAttempts);
  }

  inspect(): AuthorityState {
    return this.transact((transaction) => transaction.readState());
  }

  close(): void {
    this.#database.close();
  }

  readClock(): number {
    return this.#options.clock.read();
  }
}

/** Opens the canonical authority selected by a repository or linked worktree. */
export function openAuthorityStore(
  worktreePath: string,
  options: AuthorityStoreOptions = {},
): SqliteAuthorityStore {
  return new SqliteAuthorityStore(resolveAuthorityDatabasePath(worktreePath), options);
}
