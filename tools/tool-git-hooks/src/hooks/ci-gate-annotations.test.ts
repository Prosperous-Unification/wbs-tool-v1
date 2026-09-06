import { describe, expect, test } from 'bun:test';

import { readErrorAnnotations, selectErrorAnnotations } from './ci-gate-annotations';

describe('CI gate annotations', () => {
  test('preserves the exact file and line command emitted by the failing assertion', () => {
    const annotation =
      '::error file=libs/domain/src/is-within.test.ts,line=14,col=9::Expected false to be true';
    const nxPrefix = '\u001b[1m\u001b[34mdomain:\u001b[39m\u001b[22m ';

    expect(selectErrorAnnotations(`noise\n${nxPrefix}${annotation}\nmore noise`)).toEqual([
      annotation,
    ]);
  });

  test('keeps the first twenty unique commands in first-seen order', () => {
    const annotations = Array.from(
      { length: 21 },
      (_, index) =>
        `::error file=case-${String(index)}.test.ts,line=${String(index + 1)}::failure ${String(index)}`,
    );

    expect(
      selectErrorAnnotations([annotations[0], ...annotations, annotations[1]].join('\n')),
    ).toEqual(annotations.slice(0, 20));
  });

  test('does not turn ordinary or incomplete output into annotations', () => {
    expect(
      selectErrorAnnotations(
        [
          'error: ordinary stderr',
          '::error file=missing-line.test.ts::missing location',
          '::error line=3::missing file',
          '::error file=zero-line.test.ts,line=0::invalid location',
          '::error file=empty-message.test.ts,line=5::',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('fails when the required retained log cannot be read', async () => {
    let readError: unknown;
    try {
      await readErrorAnnotations('/path-that-does-not-exist/nx-gate.log');
    } catch (error: unknown) {
      readError = error;
    }
    expect(readError).toBeInstanceOf(Error);
  });
});
