import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

const removals: string[] = [];
const cliPath = join(import.meta.dir, '..', 'cli.ts');
const policyPath = join(
  import.meta.dir,
  '..',
  'contracts',
  'fixtures',
  'classification-policy.v1.json',
);

interface EvidenceArtifact {
  artifactId: string;
  path: string;
  blob: string;
  recordKind: 'opaque-transcript';
  references: string[];
}

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
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-artifacts-'));
  removals.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'artifacts@example.test']);
  runGit(repository, ['config', 'user.name', 'Artifact Fixture']);
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

function transcript(invocationId: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    recordKind: 'opaque-transcript',
    invocationId,
    mediaType: 'text/plain',
    payload: `payload for ${invocationId}`,
  })}\n`;
}

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function artifact(repository: string, path: string, references: string[]): EvidenceArtifact {
  const bytes = readFileSync(join(repository, path));
  return {
    artifactId: sha256(bytes),
    path,
    blob: runGit(repository, ['rev-parse', `HEAD:${path}`]),
    recordKind: 'opaque-transcript',
    references,
  };
}

function writeGraph(repository: string, graph: object): string {
  const repositoryName = repository.slice(repository.lastIndexOf('/') + 1);
  const path = join(repository, '..', `${repositoryName}-artifact-graph.json`);
  writeFileSync(path, `${JSON.stringify(graph)}\n`, 'utf8');
  removals.push(path);
  return path;
}

function runArtifacts(
  repository: string,
  revision: string,
  graphPath: string,
  env?: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(
    [
      process.execPath,
      'run',
      cliPath,
      'validate-artifacts',
      'committed',
      repository,
      revision,
      policyPath,
      graphPath,
    ],
    {
      cwd: import.meta.dir,
      env: env === undefined ? process.env : { ...process.env, ...env },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
}

function output(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return `${invocation.stdout?.toString('utf8') ?? ''}${invocation.stderr?.toString('utf8') ?? ''}`;
}

function committedEvidence(): {
  repository: string;
  revision: string;
  first: EvidenceArtifact;
  second: EvidenceArtifact;
} {
  const repository = createRepository();
  const firstPath = 'docs/review-evidence/first.v1.json';
  const secondPath = 'docs/review-evidence/second.v1.json';
  write(repository, 'src/main.ts', 'export const source = true;\n');
  write(repository, firstPath, transcript('invocation.first'));
  write(repository, secondPath, transcript('invocation.second'));
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', 'artifact graph']);
  const revision = runGit(repository, ['rev-parse', 'HEAD']);
  const second = artifact(repository, secondPath, []);
  const first = artifact(repository, firstPath, [second.artifactId]);
  return { repository, revision, first, second };
}

function graph(first: EvidenceArtifact, second: EvidenceArtifact, schemaVersion = 1): object {
  return {
    schemaVersion,
    validationId: 'validation.test.v1',
    roots: [first.artifactId],
    artifacts: [first, second].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

afterEach(() => {
  for (const path of removals.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('finite evidence artifact validation production CLI', () => {
  test('validates every reachable evidence artifact and terminates within the graph bound', () => {
    const fixture = committedEvidence();
    const graphPath = writeGraph(fixture.repository, graph(fixture.first, fixture.second));

    const invocation = runArtifacts(fixture.repository, fixture.revision, graphPath);

    expect(invocation.exitCode, output(invocation)).toBe(0);
    const report = JSON.parse(invocation.stdout?.toString('utf8') ?? '') as {
      artifactCount: number;
      visitedCount: number;
      traversalBound: number;
      validationIdentity: string;
    };
    expect(report.artifactCount).toBe(2);
    expect(report.visitedCount).toBe(2);
    expect(report.traversalBound).toBe(3);
    expect(report.validationIdentity).toMatch(/^[0-9a-f]{64}$/);

    const reordered = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    reordered.artifacts.reverse();
    const reorderedInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, reordered),
    );
    expect(reorderedInvocation.exitCode, output(reorderedInvocation)).toBe(0);
    const reorderedReport = JSON.parse(reorderedInvocation.stdout?.toString('utf8') ?? '') as {
      validationIdentity: string;
    };
    expect(reorderedReport.validationIdentity).toBe(report.validationIdentity);
  });

  test('rejects missing and extraneous graph membership', () => {
    const fixture = committedEvidence();
    const missing = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    missing.artifacts = missing.artifacts.filter(
      (candidate) => candidate.path !== fixture.second.path,
    );
    const missingInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, missing),
    );
    expect(missingInvocation.exitCode, output(missingInvocation)).toBe(1);
    expect(output(missingInvocation)).toContain('candidate evidence absent from artifact graph');

    const extraneous = structuredClone(graph(fixture.first, fixture.second)) as {
      roots: string[];
      artifacts: EvidenceArtifact[];
    };
    extraneous.roots = [];
    const extraneousInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, extraneous),
    );
    expect(extraneousInvocation.exitCode, output(extraneousInvocation)).toBe(1);
    expect(output(extraneousInvocation)).toContain('unreachable artifact');
  });

  test('rejects missing dependency identities, self obligations and cycles without timing out', () => {
    const fixture = committedEvidence();
    const missingReference = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    missingReference.artifacts[0].references = ['9'.repeat(64)];
    const missingInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, missingReference),
    );
    expect(missingInvocation.exitCode, output(missingInvocation)).toBe(1);
    expect(output(missingInvocation)).toContain(
      `missing artifact dependency ${'9'.repeat(64)} referenced by docs/review-evidence/first.v1.json`,
    );

    const self = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    self.artifacts[0].references = [fixture.first.artifactId];
    const selfInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, self),
    );
    expect(selfInvocation.exitCode, output(selfInvocation)).toBe(1);
    expect(output(selfInvocation)).toContain('evidence cannot require itself');

    const cycle = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    cycle.artifacts.find((candidate) => candidate.path === fixture.second.path)!.references = [
      fixture.first.artifactId,
    ];
    const cycleInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, cycle),
    );
    expect(cycleInvocation.exitCode, output(cycleInvocation)).toBe(1);
    expect(output(cycleInvocation)).toContain('cyclic evidence dependency');

    const missingRoot = structuredClone(graph(fixture.first, fixture.second)) as {
      roots: string[];
    };
    missingRoot.roots = ['8'.repeat(64)];
    const rootInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, missingRoot),
    );
    expect(rootInvocation.exitCode, output(rootInvocation)).toBe(1);
    expect(output(rootInvocation)).toContain('missing artifact root');
  });

  test('rejects duplicate root, artifact, path and reference identities at the boundary', () => {
    const fixture = committedEvidence();
    const cases: readonly (readonly [string, object, string])[] = [
      [
        'root',
        {
          ...graph(fixture.first, fixture.second),
          roots: [fixture.first.artifactId, fixture.first.artifactId],
        },
        'unique artifact root identities',
      ],
      [
        'artifact',
        {
          ...graph(fixture.first, fixture.second),
          artifacts: [fixture.first, { ...fixture.second, artifactId: fixture.first.artifactId }],
        },
        'artifacts with unique identities',
      ],
      [
        'path',
        {
          ...graph(fixture.first, fixture.second),
          artifacts: [fixture.first, { ...fixture.second, path: fixture.first.path }],
        },
        'artifacts with unique paths',
      ],
      [
        'reference',
        {
          ...graph(fixture.first, fixture.second),
          artifacts: [
            {
              ...fixture.first,
              references: [fixture.second.artifactId, fixture.second.artifactId],
            },
            fixture.second,
          ],
        },
        'artifact references with unique identities',
      ],
    ];
    for (const [name, malformedGraph, expected] of cases) {
      const invocation = runArtifacts(
        fixture.repository,
        fixture.revision,
        writeGraph(fixture.repository, malformedGraph),
      );
      expect(invocation.exitCode, `${name}: ${output(invocation)}`).toBe(1);
      expect(output(invocation)).toContain(expected);
    }
  });

  test('rejects unreadable bytes, malformed evidence and descriptor mismatches', () => {
    const fixture = committedEvidence();
    const wrapperDirectory = mkdtempSync(join(tmpdir(), 'tool-wiki-artifact-git-'));
    removals.push(wrapperDirectory);
    const wrapperPath = join(wrapperDirectory, 'git');
    const realGit = Bun.which('git');
    expect(realGit).not.toBeNull();
    if (realGit === null) throw new Error('required git executable disappeared during test');
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\nif [ "$3" = "cat-file" ] && [ "$5" = "$WIKI_UNREADABLE_BLOB" ]; then echo "injected unreadable artifact" >&2; exit 23; fi\nexec "$WIKI_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    chmodSync(wrapperPath, 0o755);
    const graphPath = writeGraph(fixture.repository, graph(fixture.first, fixture.second));
    const unreadable = runArtifacts(fixture.repository, fixture.revision, graphPath, {
      PATH: `${wrapperDirectory}:${process.env['PATH'] ?? ''}`,
      WIKI_REAL_GIT: realGit,
      WIKI_UNREADABLE_BLOB: fixture.second.blob,
    });
    expect(unreadable.exitCode, output(unreadable)).toBe(1);
    expect(output(unreadable)).toContain('injected unreadable artifact');

    const mismatched = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    mismatched.artifacts[0].blob = '8'.repeat(40);
    const mismatchInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, mismatched),
    );
    expect(mismatchInvocation.exitCode, output(mismatchInvocation)).toBe(1);
    expect(output(mismatchInvocation)).toContain('descriptor differs from selected evidence');

    const wrongIdentity = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    const substitutedIdentity = '7'.repeat(64);
    wrongIdentity.artifacts[0].references = [substitutedIdentity];
    wrongIdentity.artifacts[1].artifactId = substitutedIdentity;
    const identityInvocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, wrongIdentity),
    );
    expect(identityInvocation.exitCode, output(identityInvocation)).toBe(1);
    expect(output(identityInvocation)).toContain('artifact byte identity differs from graph');

    write(fixture.repository, fixture.second.path, '{"schemaVersion":1,"recordKind":"unknown"}\n');
    const malformedRevision = commitAll(fixture.repository, 'malformed evidence');
    const malformed = runArtifacts(fixture.repository, malformedRevision, graphPath);
    expect(malformed.exitCode, output(malformed)).toBe(1);
    expect(output(malformed)).toContain('does not match exactly one allowlisted evidence schema');
  });

  test('strictly decodes the bytes read during artifact validation', () => {
    const fixture = committedEvidence();
    const wrapperDirectory = mkdtempSync(join(tmpdir(), 'tool-wiki-artifact-decode-git-'));
    removals.push(wrapperDirectory);
    const wrapperPath = join(wrapperDirectory, 'git');
    const counterPath = join(wrapperDirectory, 'target-read');
    const malformed = '{"schemaVersion":1,"recordKind":"unknown"}\n';
    const realGit = Bun.which('git');
    expect(realGit).not.toBeNull();
    if (realGit === null) throw new Error('required git executable disappeared during test');
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\nif [ "$3" = "cat-file" ] && [ "$5" = "$WIKI_CHANGED_BLOB" ]; then if [ -e "$WIKI_READ_COUNTER" ]; then printf \'%s\' "$WIKI_CHANGED_BYTES"; exit 0; fi; : > "$WIKI_READ_COUNTER"; fi\nexec "$WIKI_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    chmodSync(wrapperPath, 0o755);
    const changedIdentity = sha256(malformed);
    const changedGraph = structuredClone(graph(fixture.first, fixture.second)) as {
      artifacts: EvidenceArtifact[];
    };
    changedGraph.artifacts[0].references = [changedIdentity];
    changedGraph.artifacts[1].artifactId = changedIdentity;
    const invocation = runArtifacts(
      fixture.repository,
      fixture.revision,
      writeGraph(fixture.repository, changedGraph),
      {
        PATH: `${wrapperDirectory}:${process.env['PATH'] ?? ''}`,
        WIKI_CHANGED_BLOB: fixture.second.blob,
        WIKI_CHANGED_BYTES: malformed,
        WIKI_READ_COUNTER: counterPath,
        WIKI_REAL_GIT: realGit,
      },
    );

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('recordKind must be');
  });

  test('rejects unknown graph versions before artifact traversal', () => {
    const fixture = committedEvidence();
    const graphPath = writeGraph(fixture.repository, graph(fixture.first, fixture.second, 99));

    const invocation = runArtifacts(fixture.repository, fixture.revision, graphPath);

    expect(invocation.exitCode, output(invocation)).toBe(1);
    expect(output(invocation)).toContain('schemaVersion must be 1');
  });

  test('rejects absent, unreadable and malformed graph inputs without a default', () => {
    const fixture = committedEvidence();
    const absentPath = join(fixture.repository, 'absent-artifact-graph.json');
    const absent = runArtifacts(fixture.repository, fixture.revision, absentPath);
    expect(absent.exitCode, output(absent)).toBe(1);
    expect(output(absent)).toContain(`cannot read JSON input ${absentPath}`);

    const unreadablePath = writeGraph(fixture.repository, graph(fixture.first, fixture.second));
    chmodSync(unreadablePath, 0o000);
    const unreadable = runArtifacts(fixture.repository, fixture.revision, unreadablePath);
    expect(unreadable.exitCode, output(unreadable)).toBe(1);
    expect(output(unreadable)).toContain(`cannot read JSON input ${unreadablePath}`);

    chmodSync(unreadablePath, 0o600);
    writeFileSync(unreadablePath, '{not JSON}\n', 'utf8');
    const malformed = runArtifacts(fixture.repository, fixture.revision, unreadablePath);
    expect(malformed.exitCode, output(malformed)).toBe(1);
    expect(output(malformed)).toContain(`malformed JSON input ${unreadablePath}`);

    writeFileSync(unreadablePath, new Uint8Array([0xff]));
    const nonUtf8 = runArtifacts(fixture.repository, fixture.revision, unreadablePath);
    expect(nonUtf8.exitCode, output(nonUtf8)).toBe(1);
    expect(output(nonUtf8)).toContain(`JSON input ${unreadablePath} is not UTF-8`);
  });
});
