import { readFileSync } from 'node:fs';

import { parseOrThrow } from '@wbs/validation';

import { decodeRecord, RecordKind } from './contracts/decode-record';
import { ClassificationPolicy } from './contracts/records';
import { classifyEntries } from './inventory/classify-entries';
import { type CandidateRequest, readCandidate } from './inventory/read-candidate';

function readJson(path: string): unknown {
  const source = readFileSync(path, 'utf8');
  return JSON.parse(source) as unknown;
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

function run(argv: string[]): void {
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
  throw new Error(
    'usage: tool-wiki <validate <record-kind> <json-path>|read-candidate <committed|staged|working> <repository> <revision-or-base>|classify-candidate <committed|staged|working> <repository> <revision-or-base> <policy-json>>',
  );
}

try {
  run(process.argv.slice(2));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
