import type {
  AuthorityClaim,
  AuthorityGeneration,
  AuthorityState,
  AuthorityStore,
  PathAccess,
  PathClaim,
} from './authority-store';
import {
  assertAuthorityClaimPath,
  assertAuthorityConflictGroup,
  assertAuthorityPathAccess,
  assertAuthoritySessionId,
  assertAuthorityTimestamp,
  assertAuthorityWorktreePath,
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareClaim(left: AuthorityClaim, right: AuthorityClaim): number {
  const identityOrder = compareText(left.identity, right.identity);
  if (identityOrder !== 0) return identityOrder;
  return compareText(left.kind, right.kind);
}

function normalizeClaims(
  paths: readonly ClaimIdentity[],
  conflictGroups: readonly string[],
): AuthorityClaim[] {
  const normalized = new Map<string, AuthorityClaim>();
  for (const path of paths) {
    // Proof: bypassing this validation let the empty path acquire generation 2; the malformed-
    // identity test observed that `acquireClaims` did not throw.
    assertAuthorityClaimPath(path.path);
    assertAuthorityPathAccess(path.access);
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
    assertAuthorityConflictGroup(identity);
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

function assertAvailable(
  claims: readonly AuthorityClaim[],
  generations: readonly AuthorityGeneration[],
): void {
  for (const claim of claims) {
    for (const generation of generations) {
      if (claim.kind === 'group') {
        // Proof: bypassing this comparison let both spawned worktrees acquire `root-schema`;
        // the conflict-group test observed 2 winners instead of 1.
        if (
          generation.claims.some(
            (held) => held.kind === 'group' && held.identity === claim.identity,
          )
        ) {
          throw new Error(
            `conflict-group claim belongs to session ${generation.sessionId}: ${claim.identity}`,
          );
        }
        continue;
      }
      if (
        generation.claims.some((held) => held.kind === 'path' && pathClaimsConflict(claim, held))
      ) {
        throw new Error(`path claim overlaps session ${generation.sessionId}: ${claim.identity}`);
      }
    }
  }
}

function nextState(state: AuthorityState, generation: AuthorityGeneration): AuthorityState {
  return {
    nextGeneration: generation.generation + 1,
    generations: [...state.generations, generation].sort(
      (left, right) => left.generation - right.generation,
    ),
  };
}

/** Atomically claims every requested identity for one globally new session. */
export function acquireClaims(store: AuthorityStore, request: ClaimRequest): ClaimToken {
  // Proof: bypassing this check let `bad/session` acquire generation 1; the strict-session test
  // observed that `acquireClaims` did not throw.
  assertAuthoritySessionId(request.owner.sessionId);
  // Proof: bypassing this guard let relative `relative` acquire generation 1; the canonical-
  // worktree test observed that `acquireClaims` did not throw.
  assertAuthorityWorktreePath(request.owner.worktreePath);
  const claims = normalizeClaims(request.paths, request.conflictGroups);
  // Proof: splitting a two-path acquire across two transactions let the losing spawned process
  // retain its first disjoint claim; the test observed 2 stored owners instead of 1.
  return store.transact((transaction) => {
    const state = transaction.readState();
    const acquiredAt = store.readClock();
    assertAuthorityTimestamp(acquiredAt);
    // Proof: removing this guard reached the adapter's duplicate-state failure instead; the
    // acquire test expected the public `session already exists: session-a` refusal.
    if (
      state.generations.some(
        (generation) =>
          generation.sessionId === request.owner.sessionId &&
          (generation.status === 'working' ||
            generation.status === 'investigating' ||
            generation.status === 'submitted'),
      )
    ) {
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
    const latestTimestamp = state.generations.reduce(
      (latest, generation) => Math.max(latest, generation.statusAt),
      0,
    );
    // Proof: removing this comparison let timestamp 1009 acquire after terminal timestamp 1010;
    // the lifecycle acquisition test observed generation 2 instead of a clock refusal.
    if (acquiredAt < latestTimestamp) throw new Error('authority clock regressed');
    assertAvailable(claims, state.generations);
    const token = { generation: state.nextGeneration, sessionId: request.owner.sessionId };
    transaction.writeState(
      nextState(state, {
        claims,
        generation: token.generation,
        heartbeatAt: acquiredAt,
        sessionId: token.sessionId,
        status: 'working',
        statusAt: acquiredAt,
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
  assertAuthoritySessionId(request.token.sessionId);
  if (!Number.isSafeInteger(request.token.generation) || request.token.generation < 1) {
    throw new Error(`invalid generation: ${String(request.token.generation)}`);
  }
  const additions = normalizeClaims(request.paths, request.conflictGroups);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const generation = state.generations.find(
      ({ generation, sessionId }) =>
        sessionId === request.token.sessionId && generation === request.token.generation,
    );
    // Proof: substituting an empty owner for an absent session let token `absent/1` return
    // successfully; the wrong-token test observed that `expandClaims` did not throw.
    if (generation === undefined) {
      if (state.generations.some(({ sessionId }) => sessionId === request.token.sessionId)) {
        throw new Error(`generation mismatch for session ${request.token.sessionId}`);
      }
      throw new Error(`session does not exist: ${request.token.sessionId}`);
    }
    // Proof: removing this fence let generation 99 expand session-a; the wrong-token test
    // observed that `expandClaims` did not throw.
    // Proof: admitting `submitted` here let a frozen generation add `apps/fe-01`; the submitted-
    // lifecycle test observed that `expandClaims` returned successfully instead of refusing.
    if (generation.status !== 'working') {
      throw new Error(`generation is not working: ${request.token.sessionId}`);
    }
    const others = state.generations.filter(
      ({ generation }) => generation !== request.token.generation,
    );
    // Proof: removing the expansion check let the conflicting spawned writer report `ok: true`;
    // the two-process expansion test expected the whole expansion to be refused.
    assertAvailable(additions, others);
    const expanded: AuthorityGeneration = {
      ...generation,
      claims: mergeClaims(generation.claims, additions),
    };
    transaction.writeState({
      nextGeneration: state.nextGeneration,
      generations: state.generations.map((candidate) =>
        candidate.generation === request.token.generation ? expanded : candidate,
      ),
    });
    return request.token;
  });
}
