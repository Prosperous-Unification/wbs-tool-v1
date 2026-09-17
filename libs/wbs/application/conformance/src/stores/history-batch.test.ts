import type { SavedPlanStore } from '@wbs/core';
import { describe, expect, it } from 'bun:test';

import { runCases } from '../case-runner';
import { DETERMINISTIC_SEED } from '../source-declaration';
import { type HistoryBatchFixture, historyBatchRegistrations } from './history-batch';

function rejectingFixture(cleanupFails: boolean): {
  readonly fixture: HistoryBatchFixture;
  readonly closeAfterWrite: () => boolean;
} {
  let rejectWrite: (failure: Error) => void = () => undefined;
  let didWriteSettle = false;
  const write = new Promise<never>((_resolve, reject) => {
    rejectWrite = reject;
  });
  void write.catch(() => {
    didWriteSettle = true;
  });
  const port: SavedPlanStore = {
    write: () => write,
    readOf: () => Promise.resolve(null),
    listOf: () => Promise.resolve([]),
    principalsOf: () => Promise.resolve(null),
    renameTo: () => Promise.resolve('no_such_plan'),
    deleteOf: () => Promise.resolve('no_such_plan'),
  };
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let closeAfterWrite = false;
  return {
    fixture: {
      fixtureId: cleanupFails ? 'history:triple-failure' : 'history:double-failure',
      port,
      seed: DETERMINISTIC_SEED,
      scenario: {
        kind: 'batch-settlement',
        begin: () => {
          enter();
          return Promise.resolve();
        },
        entered,
        settle: () => {
          setTimeout(() => {
            rejectWrite(new Error('injected history writer failure'));
          }, 0);
          return Promise.reject(new Error('injected history settlement failure'));
        },
      },
      close: () => {
        closeAfterWrite = didWriteSettle;
        return cleanupFails
          ? Promise.reject(new Error('injected history cleanup failure'))
          : Promise.resolve();
      },
    },
    closeAfterWrite: () => closeAfterWrite,
  };
}

describe('history batch lifecycle failures', () => {
  for (const cleanupFails of [false, true]) {
    it(`preserves writer and settlement causes${cleanupFails ? ' with cleanup' : ''}`, async () => {
      const opened = rejectingFixture(cleanupFails);
      const registrations = historyBatchRegistrations('independent-write', () =>
        Promise.resolve(opened.fixture),
      );
      const report = await runCases(registrations, {
        focus: ['history.batch:interleaved-success-survives'],
      });
      const execution = report.cases[0];

      expect(execution.status).toBe('failed');
      if (execution.status !== 'failed') throw new Error('injected history failures passed');
      // Proof: the former `finally { await settle() }` reported only settlement;
      // when cleanup also rejected it reported settlement then cleanup, losing the
      // writer rejection. The pending write was not drained before close either.
      expect(opened.closeAfterWrite()).toBe(true);
      expect(execution.failure).toBe(
        cleanupFails
          ? 'history batch write and settlement failed: [injected history writer failure; injected history settlement failure]; cleanup failed: injected history cleanup failure'
          : 'history batch write and settlement failed: [injected history writer failure; injected history settlement failure]',
      );
      expect(execution.assertionPhase).toBe(cleanupFails ? 'cleanup' : 'assertion');
    });
  }
});
