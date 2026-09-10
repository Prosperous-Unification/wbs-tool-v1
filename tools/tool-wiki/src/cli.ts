import { readFileSync } from 'node:fs';

import { parseOrThrow } from '@wbs/validation';

import { decodeRecord, RecordKind } from './contracts/decode-record';

function readJson(path: string): unknown {
  const source = readFileSync(path, 'utf8');
  return JSON.parse(source) as unknown;
}

function validate(argv: string[]): void {
  if (argv.length !== 3 || argv[0] !== 'validate') {
    throw new Error('usage: tool-wiki validate <record-kind> <json-path>');
  }
  const kind = parseOrThrow(RecordKind, argv[1]);
  decodeRecord(kind, readJson(argv[2]));
  process.stdout.write(`valid ${kind}\n`);
}

try {
  validate(process.argv.slice(2));
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
