import type {
  AuthorityClaim,
  AuthorityGeneration,
  AuthorityState,
  AuthorityStore,
  GenerationStatus,
  SubmissionIdentity,
} from './authority-store';
import {
  assertAuthoritySessionId,
  assertAuthorityTimestamp,
  assertSubmissionIdentity,
} from './authority-store';
import type { ClaimToken } from './claims';

export type { SubmissionIdentity } from './authority-store';

export interface ExpectedSubmissionAuthority {
  readonly worktreePath: string;
  readonly claims: readonly AuthorityClaim[];
}

function claimsMatch(
  actual: readonly AuthorityClaim[],
  expected: readonly AuthorityClaim[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((claim, index) => {
    const counterpart = expected[index];
    if (claim.kind !== counterpart.kind) return false;
    if (claim.identity !== counterpart.identity) return false;
    return (
      claim.kind === 'group' || (counterpart.kind === 'path' && claim.access === counterpart.access)
    );
  });
}

function latestTimestamp(state: AuthorityState): number {
  return state.generations.reduce(
    (latest, generation) => Math.max(latest, generation.heartbeatAt, generation.statusAt),
    0,
  );
}

function readTrustedTime(store: AuthorityStore): number {
  const timestamp = store.readClock();
  assertAuthorityTimestamp(timestamp);
  return timestamp;
}

function assertClockProgress(state: AuthorityState, timestamp: number): void {
  // Proof: bypassing this boundary let a trusted clock move from 1000 to 999 and refresh a live
  // generation; the production lifecycle test observed that `heartbeatGeneration` did not throw.
  if (timestamp < latestTimestamp(state)) throw new Error('authority clock regressed');
}

function findGeneration(state: AuthorityState, token: ClaimToken): AuthorityGeneration {
  // Proof: before these token boundaries, `bad/session` and generation 0 reached the absent-record
  // diagnostic; the malformed-token lifecycle test lost both exact input refusals.
  assertAuthoritySessionId(token.sessionId);
  if (!Number.isSafeInteger(token.generation) || token.generation < 1) {
    throw new Error(`invalid generation: ${String(token.generation)}`);
  }
  const generation = state.generations.find(
    // Proof: matching only the session let token session-b/1 release its generation-2 successor;
    // the two-process lifecycle test received `{ok:true}` instead of the exact absent refusal.
    (candidate) =>
      candidate.sessionId === token.sessionId && candidate.generation === token.generation,
  );
  if (generation === undefined) {
    throw new Error(`generation does not exist: ${token.sessionId}/${String(token.generation)}`);
  }
  return generation;
}

function replaceGeneration(
  state: AuthorityState,
  replacement: AuthorityGeneration,
): AuthorityState {
  return {
    ...state,
    generations: state.generations.map((generation) =>
      generation.generation === replacement.generation ? replacement : generation,
    ),
  };
}

function isTerminal(status: GenerationStatus): boolean {
  return (
    status === 'integrated' ||
    status === 'rejected' ||
    status === 'abandoned' ||
    status === 'released'
  );
}

/** Refreshes one working generation using the store-owned trusted clock. */
export function heartbeatGeneration(store: AuthorityStore, token: ClaimToken): ClaimToken {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const timestamp = readTrustedTime(store);
    assertClockProgress(state, timestamp);
    const generation = findGeneration(state, token);
    // Proof: removing only this diagnostic guard made the production lifecycle test receive
    // `generation is not working: session-a`, not the modeled investigation-fence diagnostic.
    if (generation.status === 'investigating') {
      throw new Error(`generation is fenced for investigation: ${token.sessionId}`);
    }
    // Proof: admitting `rejected` here let generation 1 refresh after generation 2 acquired; the
    // stale-writer mutation test observed that `heartbeatGeneration` did not throw.
    if (generation.status !== 'working') {
      throw new Error(
        `generation is ${isTerminal(generation.status) ? 'terminal' : 'not working'}: ${token.sessionId}`,
      );
    }
    transaction.writeState(
      replaceGeneration(state, { ...generation, heartbeatAt: timestamp, statusAt: timestamp }),
    );
    return token;
  });
}

/** Fences expired working generations for investigation without releasing their claims. */
export function fenceExpiredGenerations(
  store: AuthorityStore,
  expiryMilliseconds: number,
): readonly ClaimToken[] {
  // Proof: bypassing this boundary let duration 0 immediately fence generation 1; the duration-
  // boundary test observed a token instead of the required refusal.
  if (!Number.isSafeInteger(expiryMilliseconds) || expiryMilliseconds < 1) {
    throw new Error(`invalid heartbeat expiry duration: ${String(expiryMilliseconds)}`);
  }
  return store.transact((transaction) => {
    const state = transaction.readState();
    const timestamp = readTrustedTime(store);
    assertClockProgress(state, timestamp);
    const fenced: ClaimToken[] = [];
    const generations = state.generations.map((generation): AuthorityGeneration => {
      if (
        generation.status !== 'working' ||
        timestamp - generation.heartbeatAt < expiryMilliseconds
      ) {
        return generation;
      }
      fenced.push({ generation: generation.generation, sessionId: generation.sessionId });
      // Proof: turning expiry into `released` with no claims made the lifecycle test receive an
      // empty claim set and terminal state instead of the retained claims under `investigating`.
      return { ...generation, status: 'investigating', statusAt: timestamp };
    });
    if (fenced.length !== 0) transaction.writeState({ ...state, generations });
    return fenced;
  });
}

/** Freezes the only publication identity allowed for a working generation. */
export function submitGeneration(
  store: AuthorityStore,
  token: ClaimToken,
  submission: SubmissionIdentity,
): ClaimToken {
  return submitGenerationMatching(store, token, submission);
}

/** Freezes publication only if the generation still has the packet's exact authority state. */
export function submitGenerationMatching(
  store: AuthorityStore,
  token: ClaimToken,
  submission: SubmissionIdentity,
  expected?: ExpectedSubmissionAuthority,
): ClaimToken {
  assertSubmissionIdentity(submission);
  return store.transact((transaction) => {
    const state = transaction.readState();
    const timestamp = readTrustedTime(store);
    assertClockProgress(state, timestamp);
    const generation = findGeneration(state, token);
    // Proof: admitting `investigating` here let an expired generation publish; the expiry test
    // observed that `submitGeneration` returned its stale token instead of refusing.
    if (generation.status === 'investigating') {
      throw new Error(`generation is fenced for investigation: ${token.sessionId}`);
    }
    // Proof: removing only this diagnostic guard made the production lifecycle test receive
    // `generation is terminal: session-a`, not the modeled already-submitted diagnostic.
    if (generation.status === 'submitted') {
      throw new Error(`generation already submitted: ${token.sessionId}`);
    }
    // Proof: admitting `submitted` here and bypassing the guard above let a second process replace
    // patch identity `111...` with `444...`; the two-process lifecycle test received `{ok:true}`.
    // Admitting `rejected` here let a stale process publish generation 1 after generation
    // 2 acquired its claims; the two-process lifecycle test received `{ok:true}` instead of the
    // exact terminal refusal.
    if (generation.status !== 'working') {
      throw new Error(`generation is terminal: ${token.sessionId}`);
    }
    // Proof: omitting this same-transaction comparison let a read expansion land after packet
    // validation but before submission; the production submission mutation accepted changed
    // authority claims instead of leaving the generation working.
    if (
      expected !== undefined &&
      (generation.worktreePath !== expected.worktreePath ||
        !claimsMatch(generation.claims, expected.claims))
    ) {
      throw new Error(`generation authority differs from admission packet: ${token.sessionId}`);
    }
    transaction.writeState(
      replaceGeneration(state, {
        ...generation,
        status: 'submitted',
        statusAt: timestamp,
        submission: { ...submission },
      }),
    );
    return token;
  });
}

function finishGeneration(
  store: AuthorityStore,
  token: ClaimToken,
  allowed: ReadonlySet<GenerationStatus>,
  status: 'integrated' | 'rejected' | 'abandoned',
): ClaimToken {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const timestamp = readTrustedTime(store);
    assertClockProgress(state, timestamp);
    const generation = findGeneration(state, token);
    // Proof: admitting `rejected` here let a submitted generation integrate after its successor
    // acquired the same claims; the stale-integration test observed no terminal refusal.
    if (!allowed.has(generation.status)) {
      throw new Error(
        `generation is ${isTerminal(generation.status) ? 'terminal' : generation.status}: ${token.sessionId}`,
      );
    }
    transaction.writeState(
      replaceGeneration(state, { ...generation, claims: [], status, statusAt: timestamp }),
    );
    return token;
  });
}

/** Marks an exact submitted generation integrated and frees its claims. */
export function integrateGeneration(store: AuthorityStore, token: ClaimToken): ClaimToken {
  return finishGeneration(store, token, new Set(['submitted']), 'integrated');
}

/** Rejects exact working, investigating or submitted work and frees its claims. */
export function rejectGeneration(store: AuthorityStore, token: ClaimToken): ClaimToken {
  return finishGeneration(
    store,
    token,
    new Set(['working', 'investigating', 'submitted']),
    'rejected',
  );
}

/** Abandons exact working, investigating or submitted work and frees its claims. */
export function abandonGeneration(store: AuthorityStore, token: ClaimToken): ClaimToken {
  return finishGeneration(
    store,
    token,
    new Set(['working', 'investigating', 'submitted']),
    'abandoned',
  );
}

/** Releases exact unpublished work; a repeated release of that exact token is a no-op. */
export function releaseGeneration(store: AuthorityStore, token: ClaimToken): ClaimToken {
  return store.transact((transaction) => {
    const state = transaction.readState();
    const generation = findGeneration(state, token);
    if (generation.status === 'released') return token;
    const timestamp = readTrustedTime(store);
    assertClockProgress(state, timestamp);
    // Proof: bypassing this refusal while discarding the submission let release erase a frozen
    // publication and its claims; the submitted-lifecycle test observed no throw.
    if (generation.status === 'submitted') {
      throw new Error(`submitted generation cannot be released: ${token.sessionId}`);
    }
    // Proof: admitting `rejected` here let stale generation 1 report a successful release after
    // generation 2 acquired; the stale-writer mutation test observed no terminal refusal.
    if (generation.status !== 'working' && generation.status !== 'investigating') {
      throw new Error(`generation is terminal: ${token.sessionId}`);
    }
    transaction.writeState(
      replaceGeneration(state, {
        ...generation,
        claims: [],
        status: 'released',
        statusAt: timestamp,
      }),
    );
    return token;
  });
}
