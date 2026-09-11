import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

export const AUTHORITY_SCHEMA_VERSION = 'wbs-wiki-authority.v1' as const;

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

export interface ClaimOwner {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
  readonly claims: readonly AuthorityClaim[];
}

export interface AuthorityState {
  readonly nextGeneration: number;
  readonly owners: readonly ClaimOwner[];
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

/** One common-Git authority store; adapters must commit the callback or leave no mutation. */
export interface AuthorityStore {
  transact<T>(operation: (transaction: AuthorityTransaction) => T): T;
}

function copyClaim(claim: AuthorityClaim): AuthorityClaim {
  return claim.kind === 'path'
    ? { access: claim.access, identity: claim.identity, kind: 'path' }
    : { identity: claim.identity, kind: 'group' };
}

function copyState(state: AuthorityState): AuthorityState {
  return {
    nextGeneration: state.nextGeneration,
    owners: state.owners.map((owner) => ({
      claims: owner.claims.map(copyClaim),
      generation: owner.generation,
      sessionId: owner.sessionId,
      worktreePath: owner.worktreePath,
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

function assertMemoryState(state: AuthorityState): void {
  if (!Number.isSafeInteger(state.nextGeneration) || state.nextGeneration < 1) {
    throw new Error('invalid memory authority next generation');
  }
  const sessions = new Set<string>();
  const generations = new Set<number>();
  let highestGeneration = 0;
  for (const owner of state.owners) {
    if (sessions.has(owner.sessionId))
      throw new Error(`duplicate authority session: ${owner.sessionId}`);
    if (!Number.isSafeInteger(owner.generation) || owner.generation < 1) {
      throw new Error(`invalid authority generation for session ${owner.sessionId}`);
    }
    if (generations.has(owner.generation)) {
      throw new Error(`duplicate authority generation: ${String(owner.generation)}`);
    }
    sessions.add(owner.sessionId);
    generations.add(owner.generation);
    highestGeneration = Math.max(highestGeneration, owner.generation);
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

  constructor(initial: AuthorityState = { nextGeneration: 1, owners: [] }) {
    assertMemoryState(initial);
    this.#state = copyState(initial);
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
}

const SCHEMA = [
  `CREATE TABLE authority_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version TEXT NOT NULL,
    next_generation INTEGER NOT NULL CHECK (next_generation >= 1)
  ) STRICT`,
  `CREATE TABLE authority_owner (
    session_id TEXT PRIMARY KEY,
    worktree_path TEXT NOT NULL,
    generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1)
  ) STRICT`,
  `CREATE TABLE authority_claim (
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'group')),
    access TEXT CHECK (access IN ('read', 'write')),
    identity TEXT NOT NULL,
    PRIMARY KEY (session_id, kind, identity),
    FOREIGN KEY (session_id) REFERENCES authority_owner(session_id) ON DELETE CASCADE,
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
}

interface RequiredAuthorityStoreOptions {
  readonly maxBusyAttempts: number;
  readonly busyDelayMilliseconds: number;
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

interface OwnerRow {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly generation: number;
}

interface ClaimRow {
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: string;
  readonly access: string | null;
  readonly identity: string;
}

/** The authority exhausted its configured attempts to take SQLite's write lock. */
export class AuthorityContentionError extends Error {
  constructor(attempts: number) {
    super(`authority database remained busy after ${String(attempts)} attempts`);
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

function requiredOptions(options: AuthorityStoreOptions): RequiredAuthorityStoreOptions {
  const maxBusyAttempts = options.maxBusyAttempts ?? DEFAULT_BUSY_ATTEMPTS;
  const busyDelayMilliseconds = options.busyDelayMilliseconds ?? DEFAULT_BUSY_DELAY_MS;
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
  return { busyDelayMilliseconds, maxBusyAttempts };
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
  const rows = database
    .query<SchemaRow, []>(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
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
}

function assertSchemaWithRetry(database: Database, options: RequiredAuthorityStoreOptions): void {
  for (let attempt = 1; attempt <= options.maxBusyAttempts; attempt += 1) {
    try {
      assertSchema(database);
      return;
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (attempt === options.maxBusyAttempts) {
        throw new AuthorityContentionError(options.maxBusyAttempts);
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
  const owners = database
    .query<OwnerRow, []>(
      'SELECT session_id AS sessionId, worktree_path AS worktreePath, generation FROM authority_owner ORDER BY session_id',
    )
    .all();
  const claims = database
    .query<ClaimRow, []>(
      'SELECT session_id AS sessionId, generation, kind, access, identity FROM authority_claim ORDER BY identity, kind',
    )
    .all();
  const state: AuthorityState = {
    nextGeneration: meta.nextGeneration,
    owners: owners.map((owner) => ({
      ...owner,
      claims: claims
        .filter(
          (claim) => claim.sessionId === owner.sessionId && claim.generation === owner.generation,
        )
        .map((claim): AuthorityClaim => {
          if (claim.kind === 'group' && claim.access === null) {
            return { identity: claim.identity, kind: 'group' };
          }
          if (claim.kind === 'path' && (claim.access === 'read' || claim.access === 'write')) {
            return { access: claim.access, identity: claim.identity, kind: 'path' };
          }
          throw new Error(
            `authority database claim is invalid: ${claim.sessionId}/${claim.identity}`,
          );
        }),
    })),
  };
  assertMemoryState(state);
  if (claims.length !== state.owners.reduce((count, owner) => count + owner.claims.length, 0)) {
    throw new Error('authority database contains a claim without its exact owner generation');
  }
  return state;
}

function writeSqliteState(database: Database, state: AuthorityState): void {
  assertMemoryState(state);
  database.run('DELETE FROM authority_claim');
  database.run('DELETE FROM authority_owner');
  database
    .query<never, [number]>('UPDATE authority_meta SET next_generation = ? WHERE singleton = 1')
    .run(state.nextGeneration);
  const insertOwner = database.query<never, [string, string, number]>(
    'INSERT INTO authority_owner(session_id, worktree_path, generation) VALUES (?, ?, ?)',
  );
  const insertClaim = database.query<never, [string, number, string, string | null, string]>(
    'INSERT INTO authority_claim(session_id, generation, kind, access, identity) VALUES (?, ?, ?, ?, ?)',
  );
  for (const owner of state.owners) {
    insertOwner.run(owner.sessionId, owner.worktreePath, owner.generation);
    for (const claim of owner.claims) {
      insertClaim.run(
        owner.sessionId,
        owner.generation,
        claim.kind,
        claim.kind === 'path' ? claim.access : null,
        claim.identity,
      );
    }
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
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (attempt === this.#options.maxBusyAttempts) {
          throw new AuthorityContentionError(this.#options.maxBusyAttempts);
        }
        Bun.sleepSync(this.#options.busyDelayMilliseconds);
        continue;
      }
      try {
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
      } catch (error) {
        this.#database.run('ROLLBACK');
        throw error;
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
}

/** Opens the canonical authority selected by a repository or linked worktree. */
export function openAuthorityStore(
  worktreePath: string,
  options: AuthorityStoreOptions = {},
): SqliteAuthorityStore {
  return new SqliteAuthorityStore(resolveAuthorityDatabasePath(worktreePath), options);
}
