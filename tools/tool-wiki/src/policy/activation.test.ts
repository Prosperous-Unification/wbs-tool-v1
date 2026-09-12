import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashBytes, serializeCanonical } from '../evidence/content-manifest';
import { prepareActivation, selectActivation, verifyActivation } from './activation';

const scratch: string[] = [];
const workspace = join(import.meta.dir, '..', '..', '..', '..');
afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function fixture(version: string) {
  const source = mkdtempSync(join(tmpdir(), `wiki-activation-source-${version}-`));
  const store = mkdtempSync(join(tmpdir(), `wiki-activation-store-${version}-`));
  const candidate = mkdtempSync(join(tmpdir(), `wiki-activation-candidate-${version}-`));
  scratch.push(source, store, candidate);
  const names = {
    ciBinding: 'ci-binding.json',
    evidence: 'evidence.json',
    launcher: 'launcher.sh',
    localBinding: 'local-binding.json',
    mapping: 'mapping.json',
    policy: 'policy.json',
    reviewReceipt: 'review-receipt.json',
    snapshotter: 'snapshotter.ts',
    validator: 'validator.mjs',
  } as const;
  const roleSources = Object.fromEntries(
    Object.entries(names).map(([role, name]) => {
      const path = join(source, name);
      writeFileSync(path, `${version}:${name}\n`);
      return [role, path];
    }),
  ) as Record<keyof typeof names, string>;
  const request = {
    candidateRepository: candidate,
    mappingIdentity: hashBytes(readFileSync(roleSources.mapping)),
    policyIdentity: hashBytes(readFileSync(roleSources.policy)),
    reviewReceiptIdentity: hashBytes(readFileSync(roleSources.reviewReceipt)),
    roleSources,
    sourceRevision: '4'.repeat(40),
    validatorIdentity: hashBytes(readFileSync(roleSources.validator)),
  };
  return { candidate, request, roleSources, source, store };
}

test('prepares a role-complete immutable activation and selects its expected identity', () => {
  const subject = fixture('v1');
  const prepared = prepareActivation({
    ...subject.request,
    destination: join(subject.store, 'activation-v1'),
  });
  expect(verifyActivation(prepared.directory).identity).toBe(prepared.identity);
  const selected = selectActivation(subject.store, prepared.directory, prepared.identity);
  expect(selected.identity).toBe(prepared.identity);
  expect(selectActivation(subject.store, prepared.directory, prepared.identity)).toEqual(selected);
  writeFileSync(subject.roleSources.validator, 'changed\n');
  expect(() => prepareActivation({ ...prepared.request, destination: prepared.directory })).toThrow(
    'activation validator identity differs from its artifact',
  );
  expect(verifyActivation(selected.directory).identity).toBe(prepared.identity);
});

test('packages the real launcher and a standalone build of the real validator', () => {
  const subject = fixture('real');
  const validator = join(subject.source, 'real-validator.mjs');
  const build = Bun.spawnSync(
    [
      'bun',
      'build',
      join(workspace, 'tools/tool-wiki/src/cli.ts'),
      '--target=bun',
      '--format=esm',
      `--outfile=${validator}`,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(build.exitCode, build.stderr.toString('utf8')).toBe(0);
  const prepared = prepareActivation({
    ...subject.request,
    destination: join(subject.store, 'real'),
    roleSources: {
      ...subject.roleSources,
      launcher: join(workspace, 'bin/tool-wiki-lint.sh'),
      snapshotter: join(workspace, 'tools/tool-wiki/src/policy/snapshot-validator.ts'),
      validator,
    },
    validatorIdentity: hashBytes(readFileSync(validator)),
  });
  expect(verifyActivation(prepared.directory).manifest.roles.launcher).toBe(
    'artifacts/launcher.sh',
  );
});

test('a malformed successor cannot replace the prior selected activation', () => {
  const first = fixture('first');
  const selected = prepareActivation({
    ...first.request,
    destination: join(first.store, 'activation-first'),
  });
  selectActivation(first.store, selected.directory, selected.identity);
  const successor = fixture('successor');
  const prepared = prepareActivation({
    ...successor.request,
    destination: join(first.store, 'activation-successor'),
  });
  chmodSync(join(prepared.directory, 'artifacts', 'validator.mjs'), 0o600);
  writeFileSync(join(prepared.directory, 'artifacts', 'validator.mjs'), 'tampered\n');
  expect(() => selectActivation(first.store, prepared.directory, prepared.identity)).toThrow(
    'activation artifact digest mismatch: artifacts/validator.mjs',
  );
  const descriptor = JSON.parse(readFileSync(join(first.store, 'selected.json'), 'utf8')) as {
    identity: string;
  };
  expect(descriptor.identity).toBe(selected.identity);
});

test('activation verification refuses a missing required role artifact', () => {
  const subject = fixture('missing');
  const prepared = prepareActivation({
    ...subject.request,
    destination: join(subject.store, 'activation-missing'),
  });
  rmSync(join(prepared.directory, 'artifacts', 'snapshotter.ts'));
  expect(() => verifyActivation(prepared.directory)).toThrow(
    'cannot read activation artifact: artifacts/snapshotter.ts',
  );
});

test('selection refuses a canonical empty or unknown-field package and a wrong expected identity', () => {
  const subject = fixture('strict');
  const empty = join(subject.store, 'empty');
  mkdirSync(empty);
  writeFileSync(
    join(empty, 'manifest.json'),
    serializeCanonical({
      artifacts: [],
      mappingIdentity: '1'.repeat(64),
      policyIdentity: '2'.repeat(64),
      reviewReceiptIdentity: '3'.repeat(64),
      roles: {},
      schemaVersion: 2,
      sourceRevision: '4'.repeat(40),
      unknownTrustedField: true,
      validatorIdentity: '5'.repeat(64),
    }),
  );
  expect(() => selectActivation(subject.store, empty, hashBytes('empty'))).toThrow();
  const prepared = prepareActivation({
    ...subject.request,
    destination: join(subject.store, 'complete'),
  });
  expect(() => selectActivation(subject.store, prepared.directory, 'f'.repeat(64))).toThrow(
    'activation package differs from selected identity',
  );
});

test('strict manifest decoding rejects unknown fields, duplicate roles, and omitted roles', () => {
  const subject = fixture('manifest');
  const prepared = prepareActivation({
    ...subject.request,
    destination: join(subject.store, 'manifest'),
  });
  const manifestPath = join(prepared.directory, 'manifest.json');
  chmodSync(manifestPath, 0o600);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & {
    artifacts: unknown[];
  };
  writeFileSync(manifestPath, serializeCanonical({ ...manifest, unknownTrustedField: true }));
  expect(() => verifyActivation(prepared.directory)).toThrow();
  writeFileSync(
    manifestPath,
    serializeCanonical({
      ...manifest,
      artifacts: [...manifest.artifacts.slice(0, -1), manifest.artifacts[0]],
    }),
  );
  expect(() => verifyActivation(prepared.directory)).toThrow(
    'activation artifacts contain a duplicate role or path',
  );
  writeFileSync(
    manifestPath,
    serializeCanonical({ ...manifest, artifacts: manifest.artifacts.slice(1) }),
  );
  expect(() => verifyActivation(prepared.directory)).toThrow(
    'activation artifact set is incomplete',
  );
});

test('preparation refuses a validator source with an omitted relative dependency', () => {
  const subject = fixture('dependency');
  writeFileSync(subject.roleSources.validator, "import './dependency.js';\n");
  writeFileSync(join(subject.source, 'dependency.js'), 'export const dependency = true;\n');
  expect(() =>
    prepareActivation({
      ...subject.request,
      destination: join(subject.store, 'incomplete'),
      validatorIdentity: hashBytes(readFileSync(subject.roleSources.validator)),
    }),
  ).toThrow('activation validator is not standalone: ./dependency.js');
});

test('activation preparation refuses candidate-local and dot-prefixed child destinations', () => {
  const subject = fixture('candidate-local');
  for (const destination of [
    join(subject.candidate, 'activation-v1'),
    join(subject.candidate, '..inside'),
  ]) {
    expect(() => prepareActivation({ ...subject.request, destination })).toThrow(
      'activation package destination must be outside the candidate repository',
    );
  }
});

test('activation preparation refuses a candidate-owned role source', () => {
  const subject = fixture('candidate-source');
  const candidateValidator = join(subject.candidate, 'validator.mjs');
  writeFileSync(candidateValidator, 'export const candidate = true;\n');
  expect(() =>
    prepareActivation({
      ...subject.request,
      destination: join(subject.store, 'candidate-source'),
      roleSources: { ...subject.roleSources, validator: candidateValidator },
      validatorIdentity: hashBytes(readFileSync(candidateValidator)),
    }),
  ).toThrow('activation validator source must be outside the candidate repository');
});
