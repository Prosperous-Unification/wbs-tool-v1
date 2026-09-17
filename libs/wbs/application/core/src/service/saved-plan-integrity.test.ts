import { createHash } from 'node:crypto';

import { CANONICAL_PLAN_INPUT_SCHEMA_VERSION } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import type { Digest } from '../ports/runtime';
import {
  assertKnownBodyVersion,
  bodySha256,
  SUPPORTED_INPUT_BODY_VERSIONS,
  SUPPORTED_SCHEDULE_BODY_VERSIONS,
  UnknownSavedPlanBodyVersionError,
  verifyBody,
} from './saved-plan-integrity';
import { SCHEDULE_BODY_SCHEMA_VERSION } from './saved-plan-schedule-body';

const nodeDigest: Digest = {
  sha256: (bytes) => Promise.resolve(createHash('sha256').update(bytes, 'utf8').digest('hex')),
};

/**
 * Task 5.1b, without a database.
 *
 * The `.db` half of this slice proves the check runs on the real read path; this
 * half proves the check itself distinguishes the states, including two a
 * database is awkward to be made to produce. Both exist because a verification
 * that is only ever exercised through a service is a verification whose failing
 * branches are exercised once each, by whichever fault the harness could stage.
 */
describe('verifyBody', () => {
  const BYTES = '{"schemaVersion":1,"items":[{"id":"wi-1"}]}';

  it('accepts bytes whose recomputed digest is the stored one', async () => {
    expect(
      await verifyBody(nodeDigest, 'sp-1', 'input', BYTES, await bodySha256(nodeDigest, BYTES)),
    ).toBeNull();
  });

  it('names the plan and the body when the digest disagrees', async () => {
    const stored = await bodySha256(nodeDigest, `${BYTES} `);
    const refusal = await verifyBody(nodeDigest, 'sp-1', 'schedule', BYTES, stored);
    expect(refusal).toEqual({
      reason: 'body_hash_mismatch',
      savedPlanId: 'sp-1',
      body: 'schedule',
      stored,
      recomputed: await bodySha256(nodeDigest, BYTES),
    });
  });

  it('reports an absent body as absent rather than as a hash fault', async () => {
    // The distinction 5.1b's refusal type exists for. A cascade that removed the
    // body row and a disk fault that rewrote it are different incidents, and a
    // reader told "hash mismatch" for the first would go looking for corruption
    // in bytes that are not there at all.
    expect(
      await verifyBody(nodeDigest, 'sp-1', 'input', null, await bodySha256(nodeDigest, BYTES)),
    ).toEqual({
      reason: 'body_missing',
      savedPlanId: 'sp-1',
      body: 'input',
    });
  });

  it('refuses an empty body against a real digest instead of treating it as absent', async () => {
    // The other half of that distinction, and the one a `!bytes` test would get
    // wrong: `''` is a row that exists and holds nothing, which is a fault about
    // the bytes, not about the row.
    const refusal = await verifyBody(
      nodeDigest,
      'sp-1',
      'input',
      '',
      await bodySha256(nodeDigest, BYTES),
    );
    expect(refusal?.reason).toBe('body_hash_mismatch');
  });

  it('hashes over utf8 bytes, so a multi-byte character is not two code units', async () => {
    // `bodyByteLength` names the same encoding for the same reason. A digest
    // taken under a different one would refuse every plan whose names are not
    // ASCII — which is most of them — and pass every test written in ASCII.
    const emoji = '{"name":"🛠"}';
    const utf8 = createHash('sha256').update(Buffer.from(emoji, 'utf8')).digest('hex');
    const latin1 = createHash('sha256').update(Buffer.from(emoji, 'latin1')).digest('hex');
    // The control: the two encodings really do disagree on this string, so the
    // assertion below is about the encoding and not about two spellings of one
    // buffer.
    expect(utf8).not.toBe(latin1);
    expect(await bodySha256(nodeDigest, emoji)).toBe(utf8);
  });
});

/**
 * Task 5.5 — the version rule, as a property rather than as today's constant.
 *
 * `supported` is a parameter precisely so both clauses can be tested without
 * inventing a schema version that does not exist yet: the "reader has moved to
 * n+1" case is a list holding both, and the unknown case is a version outside
 * it.
 */
describe('assertKnownBodyVersion', () => {
  it('accepts a body at an older version the reader still knows', () => {
    // The first clause, and the one a check against the current constant alone
    // would break: every record written before a bump must keep reading.
    expect(() => {
      assertKnownBodyVersion('sp-1', 'input', 1, [1, 2]);
    }).not.toThrow();
  });

  it('throws naming the plan, the body and the version it does not know', () => {
    let thrown: unknown;
    try {
      assertKnownBodyVersion('sp-1', 'schedule', 3, [1, 2]);
    } catch (failure) {
      thrown = failure;
    }
    expect(thrown).toBeInstanceOf(UnknownSavedPlanBodyVersionError);
    if (!(thrown instanceof UnknownSavedPlanBodyVersionError)) return;
    // Named, not merely detected: a reader looking at this in a log has to know
    // which record and which half, and what this build would have accepted.
    expect(thrown.savedPlanId).toBe('sp-1');
    expect(thrown.body).toBe('schedule');
    expect(thrown.version).toBe(3);
    expect(thrown.supported).toEqual([1, 2]);
    expect(thrown.message).toContain('3');
    expect(thrown.message).toContain('sp-1');
  });

  it('never defaults an unknown version to the newest it knows (R5)', () => {
    // The negative 5.5 names — "parse optimistically and watch the unknown
    // version slip through" — as an assertion rather than a hope: a version
    // BELOW the supported floor is exactly what an optimistic reader would nod
    // through as "old, must be fine".
    expect(() => {
      assertKnownBodyVersion('sp-1', 'input', 0, [1, 2]);
    }).toThrow(UnknownSavedPlanBodyVersionError);
  });

  it('knows the version this build writes, on both sides', () => {
    // The guard that keeps the two lists honest. A bump that forgets to add
    // itself makes every plan saved by that build unreadable by it, which is a
    // failure nothing else here would catch.
    expect(SUPPORTED_INPUT_BODY_VERSIONS).toContain(CANONICAL_PLAN_INPUT_SCHEMA_VERSION);
    expect(SUPPORTED_SCHEDULE_BODY_VERSIONS).toContain(SCHEDULE_BODY_SCHEMA_VERSION);
  });
});
