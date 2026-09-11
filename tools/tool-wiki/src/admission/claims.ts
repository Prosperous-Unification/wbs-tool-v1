import { isAbsolute, normalize } from 'node:path';

import type {
  AuthorityClaim,
  AuthorityState,
  AuthorityStore,
  ClaimOwner,
  PathAccess,
  PathClaim,
} from './authority-store';

export interface ClaimIdentity {
  readonly path: string;
  readonly access: PathAccess;
}

export interface ClaimRequest {
  readonly owner: {
    readonly sessionId: string;
    readonly worktreePath: string;
  };
  readonly paths: readonly ClaimIdentity[];
  readonly conflictGroups: readonly string[];
}

export interface ClaimToken {
  readonly sessionId: string;
  readonly generation: number;
}

export interface ExpansionRequest {
  readonly token: ClaimToken;
  readonly paths: readonly ClaimIdentity[];
  readonly conflictGroups: readonly string[];
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareClaim(left: AuthorityClaim, right: AuthorityClaim): number {
  const identityOrder = compareText(left.identity, right.identity);
  if (identityOrder !== 0) return identityOrder;
  return compareText(left.kind, right.kind);
}

function assertSessionId(sessionId: string): void {
  // Proof: bypassing this check let `bad/session` acquire generation 1; the strict-session test
  // observed that `acquireClaims` did not throw.
  if (!SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

function assertWorktreePath(worktreePath: string): void {
  // Proof: bypassing this guard let relative `relative` acquire generation 1; the canonical-
  // worktree test observed that `acquireClaims` did not throw.
  if (
    !isAbsolute(worktreePath) ||
    normalize(worktreePath) !== worktreePath ||
    containsControl(worktreePath) ||
    worktreePath.includes('\\')
  ) {
    throw new Error(`invalid canonical worktree path: ${worktreePath}`);
  }
}

function assertClaimPath(path: string): void {
  const segments = path.split('/');
  // Proof: bypassing this validation let the empty path acquire generation 2; the malformed-
  // identity test observed that `acquireClaims` did not throw.
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

function normalizeClaims(
  paths: readonly ClaimIdentity[],
  conflictGroups: readonly string[],
): AuthorityClaim[] {
  const normalized = new Map<string, AuthorityClaim>();
  for (const path of paths) {
    assertClaimPath(path.path);
    const key = `path\u0000${path.path}`;
    const existing = normalized.get(key);
    if (existing?.kind === 'path' && existing.access !== path.access) {
      throw new Error(`path requested with conflicting access: ${path.path}`);
    }
    normalized.set(key, { access: path.access, identity: path.path, kind: 'path' });
  }
  for (const identity of conflictGroups) {
    // Proof: removing this validation let `bad/group` acquire generation 1; the strict-identity
    // test observed that `acquireClaims` did not throw.
    if (!GROUP.test(identity)) throw new Error(`invalid conflict group: ${identity}`);
    normalized.set(`group\u0000${identity}`, { identity, kind: 'group' });
  }
  return [...normalized.values()].sort(compareClaim);
}

function pathsOverlap(left: string, right: string): boolean {
  // Proof: reducing overlap to exact equality let parent `libs/contracts` and child
  // `libs/contracts/src` both win; the two-process test observed 2 winners instead of 1.
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathClaimsConflict(requested: PathClaim, held: PathClaim): boolean {
  // Proof: requiring both sides to be writes let session-a upgrade over session-b's read;
  // the read-to-write test observed that `expandClaims` did not throw.
  return (
    pathsOverlap(requested.identity, held.identity) &&
    (requested.access === 'write' || held.access === 'write')
  );
}

function assertAvailable(claims: readonly AuthorityClaim[], owners: readonly ClaimOwner[]): void {
  for (const claim of claims) {
    for (const owner of owners) {
      if (claim.kind === 'group') {
        // Proof: bypassing this comparison let both spawned worktrees acquire `root-schema`;
        // the conflict-group test observed 2 winners instead of 1.
        if (
          owner.claims.some((held) => held.kind === 'group' && held.identity === claim.identity)
        ) {
          throw new Error(
            `conflict-group claim belongs to session ${owner.sessionId}: ${claim.identity}`,
          );
        }
        continue;
      }
      if (owner.claims.some((held) => held.kind === 'path' && pathClaimsConflict(claim, held))) {
        throw new Error(`path claim overlaps session ${owner.sessionId}: ${claim.identity}`);
      }
    }
  }
}

function nextState(state: AuthorityState, owner: ClaimOwner): AuthorityState {
  return {
    nextGeneration: owner.generation + 1,
    owners: [...state.owners, owner].sort((left, right) =>
      compareText(left.sessionId, right.sessionId),
    ),
  };
}

/** Atomically claims every requested identity for one globally new session. */
export function acquireClaims(store: AuthorityStore, request: ClaimRequest): ClaimToken {
  assertSessionId(request.owner.sessionId);
  assertWorktreePath(request.owner.worktreePath);
  const claims = normalizeClaims(request.paths, request.conflictGroups);
  // Proof: splitting a two-path acquire across two transactions let the losing spawned process
  // retain its first disjoint claim; the test observed 2 stored owners instead of 1.
  return store.transact((transaction) => {
    const state = transaction.readState();
    // Proof: removing this guard reached the adapter's duplicate-state failure instead; the
    // acquire test expected the public `session already exists: session-a` refusal.
    if (state.owners.some((owner) => owner.sessionId === request.owner.sessionId)) {
      throw new Error(`session already exists: ${request.owner.sessionId}`);
    }
    // Proof: removing the bound attempted to persist `MAX_SAFE_INTEGER + 1`; the overflow test
    // received the adapter's invalid-state error instead of the authority exhaustion refusal.
    if (
      !Number.isSafeInteger(state.nextGeneration) ||
      state.nextGeneration >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('authority generation exhausted');
    }
    // Proof: removing this whole-set check let both spawned worktrees acquire overlapping
    // `libs/contracts` claims; the two-process test observed 2 winners instead of 1.
    assertAvailable(claims, state.owners);
    const token = { generation: state.nextGeneration, sessionId: request.owner.sessionId };
    transaction.writeState(
      nextState(state, {
        claims,
        generation: token.generation,
        sessionId: token.sessionId,
        worktreePath: request.owner.worktreePath,
      }),
    );
    return token;
  });
}

function mergeClaims(
  existing: readonly AuthorityClaim[],
  additions: readonly AuthorityClaim[],
): AuthorityClaim[] {
  const merged = new Map<string, AuthorityClaim>();
  for (const claim of existing) merged.set(`${claim.kind}\u0000${claim.identity}`, claim);
  for (const claim of additions) {
    const key = `${claim.kind}\u0000${claim.identity}`;
    const held = merged.get(key);
    if (claim.kind === 'path' && held?.kind === 'path' && held.access === 'write') continue;
    merged.set(key, claim);
  }
  return [...merged.values()].sort(compareClaim);
}

/** Atomically adds claims, including read-to-write upgrades, under the exact live token. */
export function expandClaims(store: AuthorityStore, request: ExpansionRequest): ClaimToken {
  assertSessionId(request.token.sessionId);
  if (!Number.isSafeInteger(request.token.generation) || request.token.generation < 1) {
    throw new Error(`invalid generation: ${String(request.token.generation)}`);
  }
  const additions = normalizeClaims(request.paths, request.conflictGroups);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const owner = state.owners.find(({ sessionId }) => sessionId === request.token.sessionId);
    // Proof: substituting an empty owner for an absent session let token `absent/1` return
    // successfully; the wrong-token test observed that `expandClaims` did not throw.
    if (owner === undefined) throw new Error(`session does not exist: ${request.token.sessionId}`);
    // Proof: removing this fence let generation 99 expand session-a; the wrong-token test
    // observed that `expandClaims` did not throw.
    if (owner.generation !== request.token.generation) {
      throw new Error(`generation mismatch for session ${request.token.sessionId}`);
    }
    const others = state.owners.filter(({ sessionId }) => sessionId !== request.token.sessionId);
    // Proof: removing the expansion check let the conflicting spawned writer report `ok: true`;
    // the two-process expansion test expected the whole expansion to be refused.
    assertAvailable(additions, others);
    const expanded: ClaimOwner = { ...owner, claims: mergeClaims(owner.claims, additions) };
    transaction.writeState({
      nextGeneration: state.nextGeneration,
      owners: state.owners.map((candidate) =>
        candidate.sessionId === request.token.sessionId ? expanded : candidate,
      ),
    });
    return request.token;
  });
}
