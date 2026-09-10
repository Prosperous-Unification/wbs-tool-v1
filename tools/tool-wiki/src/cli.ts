import { readFileSync } from 'node:fs';

import { parseOrThrow } from '@wbs/validation';

import { decodeRecord, RecordKind } from './contracts/decode-record';
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

function run(argv: string[]): void {
  if (argv.length === 3 && argv[0] === 'validate') {
    validateRecord(argv);
    return;
  }
  if (argv.length === 4 && argv[0] === 'read-candidate') {
    readSelectedCandidate(argv);
    return;
  }
  throw new Error(
    'usage: tool-wiki <validate <record-kind> <json-path>|read-candidate <committed|staged|working> <repository> <revision-or-base>>',
  );
}

try {
  run(process.argv.slice(2));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
