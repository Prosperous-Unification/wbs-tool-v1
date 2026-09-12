import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashBytes } from '../evidence/content-manifest';
import { prepareActivation, selectActivation, verifyActivation } from './activation';

const scratch: string[] = [];
afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function fixture(version: string) {
  const source = mkdtempSync(join(tmpdir(), `wiki-activation-source-${version}-`));
  const store = mkdtempSync(join(tmpdir(), `wiki-activation-store-${version}-`));
  scratch.push(source, store);
  const artifacts = [
    'launcher.sh',
    'snapshotter.ts',
    'validator.ts',
    'policy.json',
    'modules.json',
  ];
  for (const artifact of artifacts)
    writeFileSync(join(source, artifact), `${version}:${artifact}\n`);
  return { artifacts: artifacts.map((path) => join(source, path)), source, store };
}

test('prepares a digest-pinned immutable activation and selects it without overwriting bytes', () => {
  const subject = fixture('v1');
  const prepared = prepareActivation({
    artifacts: subject.artifacts,
    candidateRepository: subject.source,
    destination: join(subject.store, 'activation-v1'),
    mappingIdentity: '1'.repeat(64),
    policyIdentity: '2'.repeat(64),
    reviewReceiptIdentity: '3'.repeat(64),
    sourceRevision: '4'.repeat(40),
    validatorIdentity: '5'.repeat(64),
  });
  expect(verifyActivation(prepared.directory).identity).toBe(prepared.identity);
  const selected = selectActivation(subject.store, prepared.directory);
  expect(selected.identity).toBe(prepared.identity);
  expect(selectActivation(subject.store, prepared.directory)).toEqual(selected);
  writeFileSync(join(subject.source, 'validator.ts'), 'changed\n');
  expect(() =>
    prepareActivation({
      ...prepared.request,
      artifacts: subject.artifacts,
      destination: prepared.directory,
    }),
  ).toThrow('activation package already exists with different bytes');
  expect(verifyActivation(selected.directory).identity).toBe(prepared.identity);
});

test('a malformed successor cannot replace the prior selected activation', () => {
  const first = fixture('first');
  const selected = prepareActivation({
    artifacts: first.artifacts,
    candidateRepository: first.source,
    destination: join(first.store, 'activation-first'),
    mappingIdentity: '1'.repeat(64),
    policyIdentity: '2'.repeat(64),
    reviewReceiptIdentity: '3'.repeat(64),
    sourceRevision: '4'.repeat(40),
    validatorIdentity: '5'.repeat(64),
  });
  selectActivation(first.store, selected.directory);
  const successor = fixture('successor');
  const prepared = prepareActivation({
    artifacts: successor.artifacts,
    candidateRepository: successor.source,
    destination: join(first.store, 'activation-successor'),
    mappingIdentity: '6'.repeat(64),
    policyIdentity: '7'.repeat(64),
    reviewReceiptIdentity: '8'.repeat(64),
    sourceRevision: '9'.repeat(40),
    validatorIdentity: 'a'.repeat(64),
  });
  writeFileSync(join(prepared.directory, 'validator.ts'), 'tampered\n');
  expect(() => selectActivation(first.store, prepared.directory)).toThrow(
    'activation artifact digest mismatch: validator.ts',
  );
  const descriptor = JSON.parse(readFileSync(join(first.store, 'selected.json'), 'utf8')) as {
    identity: string;
  };
  expect(descriptor.identity).toBe(selected.identity);
});

test('activation verification refuses a missing transitive artifact', () => {
  const subject = fixture('missing');
  const prepared = prepareActivation({
    artifacts: subject.artifacts,
    candidateRepository: subject.source,
    destination: join(subject.store, 'activation-missing'),
    mappingIdentity: '1'.repeat(64),
    policyIdentity: '2'.repeat(64),
    reviewReceiptIdentity: '3'.repeat(64),
    sourceRevision: '4'.repeat(40),
    validatorIdentity: '5'.repeat(64),
  });
  rmSync(join(prepared.directory, 'snapshotter.ts'));
  expect(() => verifyActivation(prepared.directory)).toThrow(
    'cannot read activation artifact: snapshotter.ts',
  );
  expect(hashBytes(readFileSync(join(prepared.directory, 'manifest.json')))).toBe(
    prepared.identity,
  );
});

test('activation preparation refuses a candidate-local package destination', () => {
  const subject = fixture('candidate-local');
  expect(() =>
    prepareActivation({
      artifacts: subject.artifacts,
      candidateRepository: subject.source,
      destination: join(subject.source, 'activation-v1'),
      mappingIdentity: '1'.repeat(64),
      policyIdentity: '2'.repeat(64),
      reviewReceiptIdentity: '3'.repeat(64),
      sourceRevision: '4'.repeat(40),
      validatorIdentity: '5'.repeat(64),
    }),
  ).toThrow('activation package destination must be outside the candidate repository');
});
