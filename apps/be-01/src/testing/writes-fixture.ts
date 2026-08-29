import type { OuterTransaction } from '../service/outer-transaction';
import { WriteLock } from '../service/write-lock';

/**
 * An {@link OuterTransaction} for tests whose stores are the in-memory
 * fixtures: there is no connection to hold a transaction on, so the three calls
 * only count. Atomicity itself is proven on real SQLite in
 * `plan-commands.test.ts`; what a test on the fixtures can still assert is that
 * the runner opened, and committed or rolled back, exactly once.
 */
export function countingOuterTransaction(): OuterTransaction & {
  readonly calls: ('begin' | 'commit' | 'rollback')[];
} {
  const calls: ('begin' | 'commit' | 'rollback')[] = [];
  return {
    calls,
    begin() {
      calls.push('begin');
    },
    commit() {
      calls.push('commit');
    },
    rollback() {
      calls.push('rollback');
    },
  };
}

/** What `buildApp` needs to run command batches, for a test on the fixtures. */
export function testWrites(): {
  transactions: ReturnType<typeof countingOuterTransaction>;
  lock: WriteLock;
} {
  return { transactions: countingOuterTransaction(), lock: new WriteLock() };
}
