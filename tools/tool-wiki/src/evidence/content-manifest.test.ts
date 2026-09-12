import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { serializeCanonical } from './content-manifest';

const repositories: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const policyPath = join(
  import.meta.dir,
  '..',
  'contracts',
  'fixtures',
  'classification-policy.v1.json',
);

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = invocation.stderr.toString('utf8');
  expect(invocation.exitCode, stderr).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-content-manifest-'));
  repositories.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'manifest@example.test']);
  runGit(repository, ['config', 'user.name', 'Manifest Fixture']);
  return repository;
}

function write(repository: string, path: string, source: string): void {
  const absolutePath = join(repository, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, 'utf8');
}

function commitAll(repository: string, message: string): string {
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', message]);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function request(schemaVersion = 1): object {
  return {
    schemaVersion,
    protocol: { protocolId: 'content-manifest.v1', blob: '1'.repeat(64) },
    classificationPolicy: {
      policyId: 'classification.baseline.v1',
      blob: sha256(readFileSync(policyPath)),
    },
    relationshipInputs: [
      { inputId: 'relationship.z', blob: '3'.repeat(64) },
      { inputId: 'relationship.a', blob: '2'.repeat(64) },
    ],
    extractors: [
      { extractorId: 'extractor.z', version: 'v1', blob: '5'.repeat(64) },
      { extractorId: 'extractor.a', version: 'v1', blob: '4'.repeat(64) },
    ],
  };
}

function writeRequest(repository: string, input: object): string {
  const repositoryName = repository.slice(repository.lastIndexOf('/') + 1);
  const path = join(repository, '..', `${repositoryName}-manifest-request.json`);
  writeFileSync(path, `${JSON.stringify(input)}\n`, 'utf8');
  repositories.push(path);
  return path;
}

function runManifest(
  repository: string,
  revision: string,
  requestPath: string,
  reviewedIdentity?: string,
): ReturnType<typeof Bun.spawnSync> {
  const argv = [
    process.execPath,
    'run',
    cliPath,
    'content-manifest',
    'committed',
    repository,
    revision,
    policyPath,
    requestPath,
  ];
  if (reviewedIdentity !== undefined) argv.push(reviewedIdentity);
  return Bun.spawnSync(argv, { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' });
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${invocation.stdout?.toString('utf8') ?? ''}${invocation.stderr?.toString('utf8') ?? ''}`;
}

function manifestOutput(invocation: ReturnType<typeof Bun.spawnSync>): {
  identity: string;
  currency: 'unassessed' | 'current' | 'stale';
  manifest: {
    entries: { path: string; blob: string }[];
    relationshipInputs: { inputId: string }[];
    extractors: { extractorId: string }[];
  };
} {
  expect(invocation.exitCode, output(invocation)).toBe(0);
  return JSON.parse(invocation.stdout?.toString('utf8') ?? '') as {
    identity: string;
    currency: 'unassessed' | 'current' | 'stale';
    manifest: {
      entries: { path: string; blob: string }[];
      relationshipInputs: { inputId: string }[];
      extractors: { extractorId: string }[];
    };
  };
}

afterEach(() => {
  for (const path of repositories.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('content manifest production CLI', () => {
  test('keeps content identity current across evidence-only edits and stales it on source edits', () => {
    const repository = createRepository();
    write(repository, 'src/main.ts', 'export const answer = 1;\n');
    write(
      repository,
      'docs/review-evidence/transcript.v1.json',
      `${JSON.stringify({
        schemaVersion: 1,
        recordKind: 'opaque-transcript',
        invocationId: 'invocation.first',
        mediaType: 'text/plain',
        payload: 'first evidence bytes',
      })}\n`,
    );
    const firstRevision = commitAll(repository, 'initial content and evidence');
    const requestPath = writeRequest(repository, request());

    const first = manifestOutput(runManifest(repository, firstRevision, requestPath));
    expect(first.currency).toBe('unassessed');
    expect(first.manifest.relationshipInputs.map((input) => input.inputId)).toEqual([
      'relationship.a',
      'relationship.z',
    ]);
    expect(first.manifest.extractors.map((extractor) => extractor.extractorId)).toEqual([
      'extractor.a',
      'extractor.z',
    ]);

    write(
      repository,
      'docs/review-evidence/transcript.v1.json',
      `${JSON.stringify({
        schemaVersion: 1,
        recordKind: 'opaque-transcript',
        invocationId: 'invocation.second',
        mediaType: 'text/plain',
        payload: 'different evidence bytes',
      })}\n`,
    );
    const evidenceRevision = commitAll(repository, 'change evidence only');
    const evidenceEdit = manifestOutput(
      runManifest(repository, evidenceRevision, requestPath, first.identity),
    );
    expect(evidenceEdit.identity).toBe(first.identity);
    expect(evidenceEdit.currency).toBe('current');
    expect(first.manifest.entries.map((entry) => entry.path)).toEqual(['src/main.ts']);

    write(repository, 'src/main.ts', 'export const answer = 2;\n');
    const sourceRevision = commitAll(repository, 'change source');
    const sourceEdit = manifestOutput(
      runManifest(repository, sourceRevision, requestPath, first.identity),
    );
    expect(sourceEdit.identity).not.toBe(first.identity);
    expect(sourceEdit.currency).toBe('stale');
    expect(sourceEdit.manifest.entries[0]?.blob).not.toBe(first.manifest.entries[0]?.blob);
  });

  test('rejects an unknown manifest-request version at the production boundary', () => {
    const repository = createRepository();
    write(repository, 'src/main.ts', 'export const versioned = true;\n');
    const revision = commitAll(repository, 'version boundary');
    const requestPath = writeRequest(repository, request(99));

    const invocation = runManifest(repository, revision, requestPath);

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('schemaVersion must be 1');
  });

  test('binds the classified policy and refuses duplicate input identities', () => {
    const repository = createRepository();
    write(repository, 'src/main.ts', 'export const bound = true;\n');
    const revision = commitAll(repository, 'manifest bindings');

    const wrongPolicyId = structuredClone(request()) as {
      classificationPolicy: { policyId: string };
    };
    wrongPolicyId.classificationPolicy.policyId = 'classification.other.v1';
    const idInvocation = runManifest(repository, revision, writeRequest(repository, wrongPolicyId));
    expect(idInvocation.exitCode, output(idInvocation)).toBe(1);
    expect(output(idInvocation)).toContain('differs from classified policy');

    const wrongPolicyBlob = structuredClone(request()) as {
      classificationPolicy: { blob: string };
    };
    wrongPolicyBlob.classificationPolicy.blob = '9'.repeat(64);
    const blobInvocation = runManifest(
      repository,
      revision,
      writeRequest(repository, wrongPolicyBlob),
    );
    expect(blobInvocation.exitCode, output(blobInvocation)).toBe(1);
    expect(output(blobInvocation)).toContain('differs from actual policy blob');

    const duplicateInput = structuredClone(request()) as {
      relationshipInputs: { inputId: string; blob: string }[];
    };
    duplicateInput.relationshipInputs[1].inputId = duplicateInput.relationshipInputs[0].inputId;
    const duplicateInvocation = runManifest(
      repository,
      revision,
      writeRequest(repository, duplicateInput),
    );
    expect(duplicateInvocation.exitCode, output(duplicateInvocation)).toBe(1);
    expect(output(duplicateInvocation)).toContain('relationship inputs with unique inputId');

    const duplicateExtractor = structuredClone(request()) as {
      extractors: { extractorId: string; version: string; blob: string }[];
    };
    duplicateExtractor.extractors[1].extractorId = duplicateExtractor.extractors[0].extractorId;
    const extractorInvocation = runManifest(
      repository,
      revision,
      writeRequest(repository, duplicateExtractor),
    );
    expect(extractorInvocation.exitCode, output(extractorInvocation)).toBe(1);
    expect(output(extractorInvocation)).toContain('extractors with unique extractorId');

    const invalidCurrency = runManifest(
      repository,
      revision,
      writeRequest(repository, request()),
      'not-a-content-identity',
    );
    expect(invalidCurrency.exitCode, output(invalidCurrency)).toBe(1);
    expect(output(invalidCurrency)).toContain('reviewed content identity is not SHA-256');
    // Proof: PR run 34694906449 timed this production path out at 5018.89ms under
    // Bun's 5-second default, after its child was still running (`Received: null`).
  }, 10_000);
});

describe('canonical JSON', () => {
  test('sorts recursive object keys, preserves semantic array order and writes one newline', () => {
    expect(
      serializeCanonical({
        z: [{ beta: true, alpha: null }, 2],
        a: 'first',
      }),
    ).toBe('{"a":"first","z":[{"alpha":null,"beta":true},2]}\n');
  });

  test('orders distinct keys deterministically when their UTF-8 encodings tie', () => {
    const ascending = Object.fromEntries([
      ['\ud800', 'first'],
      ['\ud801', 'second'],
    ]);
    const descending = Object.fromEntries([
      ['\ud801', 'second'],
      ['\ud800', 'first'],
    ]);

    expect(serializeCanonical(ascending)).toBe(serializeCanonical(descending));
    expect(serializeCanonical(ascending)).toBe('{"\\ud800":"first","\\ud801":"second"}\n');
  });

  test('refuses values outside the finite JSON value model', () => {
    class UnsupportedRecord {
      field = 'implementation class';
    }

    expect(() => serializeCanonical(new Map([['field', 'map']]))).toThrow('plain JSON object');
    expect(() => serializeCanonical(new UnsupportedRecord())).toThrow('plain JSON object');
    expect(() => serializeCanonical({ field: undefined })).toThrow('undefined');
    expect(() => serializeCanonical({ field: Number.POSITIVE_INFINITY })).toThrow('finite number');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonical(cyclic)).toThrow('cyclic JSON value');
  });
});
