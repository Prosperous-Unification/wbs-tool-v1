import { compareCanonicalText } from '../evidence/content-manifest';
import type {
  AuthorityClaim,
  AuthorityGeneration,
  AuthorityPacketBinding,
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

export interface PacketAuthorityExpectation {
  readonly claims: readonly AuthorityClaim[];
  readonly packet?: AuthorityPacketBinding;
  readonly token: ClaimToken;
  readonly worktreePath: string;
}

export interface BoundPacketExpansion extends PacketAuthorityExpectation {
  readonly additions: readonly ClaimIdentity[];
  readonly nextPacket: AuthorityPacketBinding;
}

function compareClaim(left: AuthorityClaim, right: AuthorityClaim): number {
  // Proof: restoring JavaScript code-unit order put U+10000 before U+E000 while packet order did
  // the reverse; the acquire/create production test refused identical claim sets as different.
  const identityOrder = compareCanonicalText(left.identity, right.identity);
  if (identityOrder !== 0) return identityOrder;
  return compareCanonicalText(left.kind, right.kind);
}

export function authorityClaimsMatch(
  actual: readonly AuthorityClaim[],
  expected: readonly AuthorityClaim[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((claim, index) => {
    const counterpart = expected[index];
    if (claim.kind !== counterpart.kind || claim.identity !== counterpart.identity) return false;
    return (
      claim.kind === 'group' || (counterpart.kind === 'path' && claim.access === counterpart.access)
    );
  });
}

function packetBindingsMatch(
  actual: AuthorityPacketBinding | undefined,
  expected: AuthorityPacketBinding | undefined,
): boolean {
  return (
    actual?.packetIdentity === expected?.packetIdentity &&
    actual?.packetBytes === expected?.packetBytes
  );
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

function workingGeneration(state: AuthorityState, token: ClaimToken): AuthorityGeneration {
  const generation = state.generations.find(
    (candidate) =>
      candidate.sessionId === token.sessionId && candidate.generation === token.generation,
  );
  if (generation?.status !== 'working') {
    throw new Error(`generation is not working: ${token.sessionId}`);
  }
  return generation;
}

function assertPacketAuthority(
  generation: AuthorityGeneration,
  expectation: PacketAuthorityExpectation,
): void {
  if (
    generation.worktreePath !== expectation.worktreePath ||
    !authorityClaimsMatch(generation.claims, expectation.claims)
  ) {
    throw new Error(
      `generation authority differs from admission packet: ${expectation.token.sessionId}`,
    );
  }
  // Proof: omitting this exact binding comparison let a rehashed `check.forged` packet expand
  // reads; the production expansion test received a new packet instead of refusal.
  if (!packetBindingsMatch(generation.packet, expectation.packet)) {
    throw new Error(`packet binding differs from authority: ${expectation.token.sessionId}`);
  }
}

/** Binds one exact canonical packet to an unbound working generation. */
export function bindAdmissionPacket(
  store: AuthorityStore,
  expectation: PacketAuthorityExpectation & { readonly nextPacket: AuthorityPacketBinding },
): ClaimToken {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const generation = workingGeneration(state, expectation.token);
    if (
      generation.worktreePath !== expectation.worktreePath ||
      !authorityClaimsMatch(generation.claims, expectation.claims)
    ) {
      throw new Error(
        `generation authority differs from admission packet: ${expectation.token.sessionId}`,
      );
    }
    if (generation.packet !== undefined) {
      // Proof: accepting a different binding here let a second `check.forged` packet replace the
      // admitted packet; the production bind-once test received the forged packet.
      if (!packetBindingsMatch(generation.packet, expectation.nextPacket)) {
        throw new Error(`packet binding differs from authority: ${expectation.token.sessionId}`);
      }
      return expectation.token;
    }
    const bound = { ...generation, packet: { ...expectation.nextPacket } };
    transaction.writeState({
      ...state,
      generations: state.generations.map((candidate) =>
        candidate.generation === expectation.token.generation ? bound : candidate,
      ),
    });
    return expectation.token;
  });
}

/** Atomically expands read claims and replaces their authenticated packet binding. */
export function expandBoundPacketClaims(
  store: AuthorityStore,
  request: BoundPacketExpansion,
): ClaimToken {
  const additions = normalizeClaims(request.additions, []);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const generation = workingGeneration(state, request.token);
    assertPacketAuthority(generation, request);
    const others = state.generations.filter(
      ({ generation: identity }) => identity !== request.token.generation,
    );
    assertAvailable(additions, others);
    const expanded = {
      ...generation,
      claims: mergeClaims(generation.claims, additions),
      // Proof: retaining the old binding while adding reads left authority at `1297b6...` while
      // the returned packet was `1e6531...`; the production expansion assertion observed both.
      packet: { ...request.nextPacket },
    };
    transaction.writeState({
      ...state,
      generations: state.generations.map((candidate) =>
        candidate.generation === request.token.generation ? expanded : candidate,
      ),
    });
    return request.token;
  });
}
