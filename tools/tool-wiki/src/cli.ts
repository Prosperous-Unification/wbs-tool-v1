import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseOrThrow } from '@wbs/validation';

import { decodeRecord, RecordKind } from './contracts/decode-record';
import {
  ArtifactGraph,
  ClassificationPolicy,
  ContentManifestRequest,
  RelationshipRequest,
} from './contracts/records';
import {
  buildContentManifest,
  compareContentIdentity,
  hashBytes,
  validateArtifacts,
} from './evidence/content-manifest';
import { checkIndexes, checkRootMigration } from './indexes';
import { type ClassifiedCandidate, classifyEntries } from './inventory/classify-entries';
import { type CandidateRequest, readCandidate } from './inventory/read-candidate';
import { extractRelationships } from './relationships';
import {
  type ProvenanceRequirement,
  readInvocationJournal,
  validateReviewProvenance,
} from './review/invoker';

interface JsonDocument {
  bytes: Uint8Array;
  input: unknown;
}

function readJsonDocument(path: string): JsonDocument {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: substituting `{}` for an absent required graph lost this boundary and failed later
    // with four missing schema fields instead of naming the unreadable input path.
    throw new Error(`cannot read JSON input ${path}: ${detail}`, { cause });
  }
  let source: string;
  try {
    // Proof: removing fatal UTF-8 decoding made the production graph boundary replace 0xff and
    // misreport it as generic malformed JSON instead of refusing the byte encoding itself.
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`JSON input ${path} is not UTF-8: ${detail}`, { cause });
  }
  try {
    return { bytes, input: JSON.parse(source) as unknown };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: substituting `{}` for malformed graph JSON lost the parse boundary and reported four
    // absent schema fields; the production oracle required the malformed input path instead.
    throw new Error(`malformed JSON input ${path}: ${detail}`, { cause });
  }
}

function readJson(path: string): unknown {
  return readJsonDocument(path).input;
}

function validateRecord(argv: string[]): void {
  const kind = parseOrThrow(RecordKind, argv[1]);
  decodeRecord(kind, readJson(argv[2]));
  process.stdout.write(`valid ${kind}\n`);
}

function readSelectedCandidate(argv: string[]): void {
  const kind = argv[1];
  const repository = argv[2];
  const revision = argv[3];
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error(
      'usage: tool-wiki read-candidate <committed|staged|working> <repository> <revision-or-base>',
    );
  }
  const request: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  process.stdout.write(`${JSON.stringify(readCandidate(repository, request))}\n`);
}

function readBlob(repository: string, blob: string, path: string): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, 'cat-file', 'blob', blob], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    // Proof: an injected exit 23 made artifact validation refuse
    // `docs/review-evidence/second.v1.json: injected unreadable artifact` at this boundary.
    const detail = invocation.stderr.toString('utf8').trim();
    throw new Error(
      `cannot read selected blob ${blob} for ${path}: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail}`,
    );
  }
  return invocation.stdout;
}

function classifyCandidate(argv: string[]): void {
  const kind = argv[1];
  const repository = argv[2];
  const revision = argv[3];
  const policyPath = argv[4];
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error(
      'usage: tool-wiki classify-candidate <committed|staged|working> <repository> <revision-or-base> <policy-json>',
    );
  }
  const policy = parseOrThrow(ClassificationPolicy, readJson(policyPath));
  const request: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  const candidate = readCandidate(repository, request);
  process.stdout.write(
    `${JSON.stringify({
      selection: candidate.selection,
      entries: classifyEntries(candidate.entries, policy, (blob, path) =>
        readBlob(repository, blob, path),
      ),
      untracked: candidate.untracked,
      policyId: policy.policyId,
    })}\n`,
  );
}

function classifySelectedCandidate(
  kind: string,
  repository: string,
  revision: string,
  policyPath: string,
): { candidate: ClassifiedCandidate; policyBlob: string } {
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error('candidate kind must be committed, staged or working');
  }
  const policyDocument = readJsonDocument(policyPath);
  const policy = parseOrThrow(ClassificationPolicy, policyDocument.input);
  const request: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  const snapshot = readCandidate(repository, request);
  return {
    candidate: {
      selection: snapshot.selection,
      entries: classifyEntries(snapshot.entries, policy, (blob, path) =>
        readBlob(repository, blob, path),
      ),
      untracked: snapshot.untracked,
      policyId: policy.policyId,
    },
    policyBlob: hashBytes(policyDocument.bytes),
  };
}

function writeContentManifest(argv: string[]): void {
  const [kind, repository, revision, policyPath, requestPath, reviewedIdentity] = argv.slice(1);
  const request = parseOrThrow(ContentManifestRequest, readJson(requestPath));
  const classified = classifySelectedCandidate(kind, repository, revision, policyPath);
  const built = buildContentManifest(classified.candidate, request, classified.policyBlob);
  process.stdout.write(
    `${JSON.stringify({
      identity: built.identity,
      currency: compareContentIdentity(reviewedIdentity, built.identity),
      manifest: built.manifest,
    })}\n`,
  );
}

function writeArtifactValidation(argv: string[]): void {
  const [kind, repository, revision, policyPath, graphPath] = argv.slice(1);
  const graph = parseOrThrow(ArtifactGraph, readJson(graphPath));
  const classified = classifySelectedCandidate(kind, repository, revision, policyPath);
  const report = validateArtifacts(classified.candidate, graph, (blob, path) =>
    readBlob(repository, blob, path),
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

function writeRelationships(argv: string[]): void {
  const [kind, repository, revision, requestPath] = argv.slice(1);
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error('relationship candidate kind must be committed, staged or working');
  }
  const request = parseOrThrow(RelationshipRequest, readJson(requestPath));
  const candidateRequest: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  process.stdout.write(
    `${JSON.stringify(extractRelationships(repository, readCandidate(repository, candidateRequest), request))}\n`,
  );
}

function writeIndexChecks(argv: string[]): void {
  const [kind, repository, revision] = argv.slice(1);
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error('index candidate kind must be committed, staged or working');
  }
  const request: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  process.stdout.write(
    `${JSON.stringify(checkIndexes(repository, readCandidate(repository, request)))}\n`,
  );
}

function writeRootMigrationCheck(argv: string[]): void {
  const [kind, repository, revision, mapPath] = argv.slice(1);
  if (kind !== 'committed' && kind !== 'staged' && kind !== 'working') {
    throw new Error('root migration candidate kind must be committed, staged or working');
  }
  const request: CandidateRequest =
    kind === 'committed' ? { kind, revision } : { kind, base: revision };
  process.stdout.write(
    `${JSON.stringify(checkRootMigration(repository, readCandidate(repository, request), mapPath))}\n`,
  );
}

function writeReviewProvenance(argv: string[]): void {
  const [, journalPath, evidencePath, requirementInput] = argv;
  if (requirementInput !== 'allow-local' && requirementInput !== 'require-external') {
    throw new Error('review provenance requirement must be allow-local or require-external');
  }
  const requirement: ProvenanceRequirement = requirementInput;
  const validation = validateReviewProvenance(
    readInvocationJournal(journalPath),
    readJson(evidencePath),
    requirement,
  );
  process.stdout.write(`${JSON.stringify(validation)}\n`);
}

declare const __TOOL_WIKI_BUNDLED_ARTIFACTS__: string;

function validatorEntryPaths(): string[] | { artifactManifest: string } {
  if (typeof __TOOL_WIKI_BUNDLED_ARTIFACTS__ === 'string') {
    return { artifactManifest: __TOOL_WIKI_BUNDLED_ARTIFACTS__ };
  }
  return [join(import.meta.dir, 'cli.ts'), join(import.meta.dir, 'policy', 'trust.ts')];
}

function run(argv: string[]): Promise<void> | void {
  if (argv.length === 3 && argv[0] === 'validate') {
    validateRecord(argv);
    return;
  }
  if (argv.length === 4 && argv[0] === 'read-candidate') {
    readSelectedCandidate(argv);
    return;
  }
  if (argv.length === 5 && argv[0] === 'classify-candidate') {
    classifyCandidate(argv);
    return;
  }
  if ((argv.length === 6 || argv.length === 7) && argv[0] === 'content-manifest') {
    writeContentManifest(argv);
    return;
  }
  if (argv.length === 6 && argv[0] === 'validate-artifacts') {
    writeArtifactValidation(argv);
    return;
  }
  if (argv.length === 5 && argv[0] === 'extract-relationships') {
    writeRelationships(argv);
    return;
  }
  if (argv.length === 4 && argv[0] === 'check-indexes') {
    writeIndexChecks(argv);
    return;
  }
  if (argv.length === 5 && argv[0] === 'check-root-migration') {
    writeRootMigrationCheck(argv);
    return;
  }
  if (argv.length === 4 && argv[0] === 'validate-review-provenance') {
    writeReviewProvenance(argv);
    return;
  }
  if (argv.length === 7 && argv[0] === 'lint-local') {
    return import('./policy/trust').then(({ writeLocalLintCommand }) => {
      writeLocalLintCommand(argv, validatorEntryPaths());
    });
  }
  if (argv.length === 5 && argv[0] === 'lint-ci') {
    return import('./policy/trust').then(({ writeCiLintCommand }) => {
      writeCiLintCommand(argv, validatorEntryPaths());
    });
  }
  if (argv.length === 4 && argv[0] === 'validate-policy-activation') {
    return import('./policy/trust').then(({ writePolicyActivationCommand }) => {
      writePolicyActivationCommand(argv, validatorEntryPaths());
    });
  }
  throw new Error(
    'usage: tool-wiki <validate|read-candidate|classify-candidate|content-manifest|validate-artifacts|extract-relationships|check-indexes|check-root-migration|validate-review-provenance|lint-local|lint-ci|validate-policy-activation> ...',
  );
}

function fail(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

try {
  const pending = run(process.argv.slice(2));
  if (pending !== undefined) void pending.catch(fail);
} catch (cause) {
  fail(cause);
}
