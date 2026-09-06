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

  test('preserves a raw comma inside a workflow-command property value', () => {
    const annotation =
      '::error file=comma.test.ts,line=7,col=3,title=error: bad input, expected number::Boom';
    const equalsAnnotation =
      '::error file=equals.test.ts,line=8,title=assertion failed: x=1, y=2, line=diagnostic text::Boom';

    // Proof: rejecting comma-separated continuations made this located command
    // disappear instead of preserving the exact command GitHub understands.
    expect(selectErrorAnnotations(`${annotation}\n${equalsAnnotation}`)).toEqual([
      annotation,
      equalsAnnotation,
    ]);
  });

  test('accepts only column zero or the exact ANSI Nx stream prefix', () => {
    const annotation = '::error file=anchored.test.ts,line=3::real failure';
    const proseAnnotation = '::error file=prose.test.ts,line=4::printed, not emitted';
    const plainPrefixAnnotation = '::error file=plain-prefix.test.ts,line=5::not ANSI Nx';
    const invalidProjectAnnotation =
      '::error file=invalid-project.test.ts,line=6::not an Nx project prefix';
    const nxPrefix = '\u001b[1m\u001b[35mtool-git-hooks:\u001b[39m\u001b[22m ';

    // Proof: matching `::error` at any offset promoted the prose fixture into a
    // real annotation aimed at a file that did not fail.
    expect(
      selectErrorAnnotations(
        [
          `ordinary prose printed ${proseAnnotation}`,
          `tool-git-hooks: ${plainPrefixAnnotation}`,
          `\u001b[1m\u001b[35mbad project:\u001b[39m\u001b[22m ${invalidProjectAnnotation}`,
          `${nxPrefix}${annotation}`,
        ].join('\n'),
      ),
    ).toEqual([annotation]);
  });

  test('accepts every colour in the Nx stream prefix cycle', () => {
    const colourCodes = [32, 92, 34, 94, 36, 96, 33, 93, 35, 95];
    const cases = colourCodes.map((colour, index) => {
      const annotation = `::error file=colour-${String(colour)}.test.ts,line=${String(index + 1)}::failure`;
      return {
        annotation,
        line: `\u001b[1m\u001b[${String(colour)}mproject-${String(index)}:\u001b[39m\u001b[22m ${annotation}`,
      };
    });

    // Proof: hard-coding blue retained only the colour-34 command and dropped
    // the other nine real Nx stream prefixes.
    expect(selectErrorAnnotations(cases.map(({ line }) => line).join('\n'))).toEqual(
      cases.map(({ annotation }) => annotation),
    );
  });

  test('accepts the exact non-bold Nx stderr stream prefix', () => {
    const annotation = '::error file=stderr.test.ts,line=9::failure on stderr';
    const nxStderrPrefix = '\u001b[35mtool-git-hooks:\u001b[39m ';

    // Proof: requiring Nx's stdout-only bold codes dropped a workflow command
    // when the same project prefix came from the stderr pipe.
    expect(selectErrorAnnotations(`${nxStderrPrefix}${annotation}`)).toEqual([annotation]);
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

  test('rejects limits outside the positive-safe-integer contract', () => {
    expect(() => selectErrorAnnotations('', 0)).toThrow(RangeError);
    expect(() => selectErrorAnnotations('', 1.5)).toThrow(RangeError);
    expect(() => selectErrorAnnotations('', Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
