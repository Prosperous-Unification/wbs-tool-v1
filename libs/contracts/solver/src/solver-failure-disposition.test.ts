import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { SOLVER_PARSE_FAILURES } from './parse-solver-response';
import { SOLVER_REVALIDATION_FAILURES } from './revalidate-solver-result';
import {
  dispositionOfExitCode,
  dispositionOfParseFailure,
  dispositionOfPreflightFailure,
  dispositionOfRevalidationFailure,
  SOLVER_EXIT_CODES,
  SOLVER_FAILURE_DISPOSITIONS,
  SOLVER_FAILURE_REASONS,
} from './solver-failure-disposition';
import { SOLVER_PREFLIGHT_FAILURES } from './solver-preflight';

/**
 * 2.5's remaining clause: "each violation in 2.4 is rejected as
 * **invalid-output**". The violations themselves are cased one-by-one in
 * `revalidate-solver-result.test.ts`; what was untestable until now is the
 * disposition, because `invalid-output` existed only in doc comments.
 *
 * The vocabulary is not asserted against a second hand-written list here. It is
 * read out of `design.md`'s CHECK constraint, which is the text the migration
 * will carry, so this file cannot agree with a constant that has drifted from
 * the column that stores it — the same non-circularity argument the golden
 * corpus makes for the wire schema.
 */

const DESIGN = readFileSync(
  new URL('../../../../openspec/changes/dual-optimized-scheduler/design.md', import.meta.url),
  'utf8',
);

/** The `failureReason` CHECK constraint's own list, in its own order. */
const checkConstraintVocabulary = (): string[] => {
  const match = /failure_reason IS NULL OR failure_reason IN \(([^)]*)\)/.exec(DESIGN);
  if (!match) throw new Error('design.md no longer declares a failure_reason CHECK constraint');
  return match[1].split(',').map((token) => token.trim().replace(/^'|'$/g, ''));
};

describe('the failure-reason vocabulary is the column the row is written into', () => {
  it('matches design.md CHECK constraint exactly, in order', () => {
    expect(SOLVER_FAILURE_REASONS.map(String)).toEqual(checkConstraintVocabulary());
  });

  it('carries no duplicate', () => {
    expect(new Set(SOLVER_FAILURE_REASONS).size).toBe(SOLVER_FAILURE_REASONS.length);
  });
});

describe('every failure this directory can produce has exactly one disposition', () => {
  // The name carried a literal count until run 47 and it had already drifted:
  // it said fifteen against seventeen tokens, and 2.4's `deadline-violated`
  // made it eighteen. Both sides of the assertion derive the number, so the
  // count in the name was decoration that could only ever go stale.
  it('covers every token across all three seams, with no seam left out', () => {
    expect(SOLVER_FAILURE_DISPOSITIONS).toHaveLength(
      SOLVER_PARSE_FAILURES.length +
        SOLVER_PREFLIGHT_FAILURES.length +
        SOLVER_REVALIDATION_FAILURES.length,
    );
  });

  it('maps every one of them into the CHECK constraint vocabulary', () => {
    const admitted = new Set<string>(SOLVER_FAILURE_REASONS);
    for (const { seam, failure, reason } of SOLVER_FAILURE_DISPOSITIONS) {
      expect(admitted.has(reason), `${seam}/${failure} -> ${reason}`).toBe(true);
    }
  });
});

describe('framing is always invalid-output', () => {
  it('gives every one of the four the same disposition', () => {
    for (const failure of SOLVER_PARSE_FAILURES) {
      expect(dispositionOfParseFailure(failure)).toBe('invalid-output');
    }
  });
});

describe('re-validation is invalid-output except on our own side of the seam', () => {
  it('rejects every solver-authored violation as invalid-output', () => {
    for (const failure of SOLVER_REVALIDATION_FAILURES) {
      if (failure === 'malformed-request') continue;
      expect(dispositionOfRevalidationFailure(failure), failure).toBe('invalid-output');
    }
  });

  it('sends an unjudgeable request to internal-error, not to the solver', () => {
    expect(dispositionOfRevalidationFailure('malformed-request')).toBe('internal-error');
  });

  it('leaves exactly one code on our side, so the rule stays a rule', () => {
    const ours = SOLVER_REVALIDATION_FAILURES.filter(
      (failure) => dispositionOfRevalidationFailure(failure) !== 'invalid-output',
    );
    expect(ours).toEqual(['malformed-request']);
  });
});

/**
 * The exit-code seam, and the one row it exists for: `INFEASIBLE, k > 1`.
 *
 * The wire reserves `infeasible` for a proof about the submitted constraint
 * system, so a later stage that reports it holds a counterexample to its own
 * earlier answer and must not encode it. spec.md's staged-lexicographic
 * requirement therefore sends that run out through a non-zero exit with an
 * empty stdout and says the coordinator "SHALL record that run as
 * `invalid-output`" — a sentence with no implementation at all while every
 * non-zero exit collapsed onto `internal-error`.
 *
 * The two codes are asserted apart on purpose. If `64` and `70` shared a
 * disposition there would be nothing to get wrong and no reason for this seam
 * to exist; they differ because one is the solver failing to answer and the
 * other is our own builder handing it a request it could not read.
 */
describe('a solver that ran and answered nothing is invalid-output', () => {
  it('records the later-stage INFEASIBLE exit as invalid-output', () => {
    expect(dispositionOfExitCode(SOLVER_EXIT_CODES.solveFailed)).toBe('invalid-output');
  });

  it('keeps a refused request on our own side of the seam', () => {
    expect(dispositionOfExitCode(SOLVER_EXIT_CODES.badRequest)).toBe('internal-error');
  });

  it('treats a death that reached neither exit as internal-error', () => {
    for (const code of [1, 2, 137, 139]) {
      expect(dispositionOfExitCode(code), String(code)).toBe('internal-error');
    }
  });

  it('refuses exit 0, which wrote a response and is not a failure at all', () => {
    expect(() => dispositionOfExitCode(SOLVER_EXIT_CODES.ok)).toThrow(/wrote a response/);
  });

  it('reads its codes from the entrypoint that emits them', () => {
    const cli = readFileSync(
      new URL('../../../../libs/solver-py/src/wbs_solver/cli.py', import.meta.url),
      'utf8',
    );
    const codeOf = (name: string): number => {
      const match = new RegExp(`^${name} = (\\d+)$`, 'm').exec(cli);
      if (!match) throw new Error(`cli.py no longer defines ${name}`);
      return Number(match[1]);
    };
    // Parsed value first: `SOLVER_EXIT_CODES` is `as const`, so each member is
    // a literal type and `toBe` would narrow the expectation to that literal
    // and reject a plain `number` — the constant would be checking the file
    // against itself, backwards.
    expect(codeOf('EXIT_OK')).toBe(SOLVER_EXIT_CODES.ok);
    expect(codeOf('EXIT_BAD_REQUEST')).toBe(SOLVER_EXIT_CODES.badRequest);
    expect(codeOf('EXIT_INTERNAL')).toBe(SOLVER_EXIT_CODES.solveFailed);
  });
});

describe('pre-spawn failures are the recorded reason verbatim', () => {
  it('passes both tokens through unchanged', () => {
    for (const failure of SOLVER_PREFLIGHT_FAILURES) {
      expect(dispositionOfPreflightFailure(failure)).toBe(failure);
    }
  });
});

/**
 * The reason this module exists rather than a switch at the call site. Both
 * assertions read `objective-overflow`; they disagree, and a mapping that
 * matched the token to the column's vocabulary would pass the first and fail
 * the second while looking correct in both places.
 *
 * WATCHED RED, MEASURED at `9be51528`: set
 * `REVALIDATION_DISPOSITIONS['objective-overflow']` to `'objective-overflow'` —
 * the single most plausible edit, since the token is itself a legal
 * `failureReason` and the entry beside it in the preflight table says exactly
 * that. Result **164 pass / 3 fail**, where this comment first predicted one.
 * The other two are the enumerating cases above — "rejects every
 * solver-authored violation" and "leaves exactly one code on our side" — and
 * that they fire is the point rather than noise: each states the rule over the
 * whole list, so neither can be satisfied by a token-shaped exception.
 *
 * What did NOT fire is the part worth keeping. Every one of the other 164
 * passes, including the re-validator's own suite, which asserts the diagnosis
 * token and is unchanged; and including the vocabulary and totality checks
 * above, which pass because the wrong answer is a member of the column's own
 * enum. Nothing outside this file notices at all.
 */
describe('the same token means opposite things on either side of the spawn', () => {
  it('records objective-overflow before the spawn and invalid-output after it', () => {
    expect(dispositionOfPreflightFailure('objective-overflow')).toBe('objective-overflow');
    expect(dispositionOfRevalidationFailure('objective-overflow')).toBe('invalid-output');
  });

  it('is the only token two seams share, so nothing else needs the pair', () => {
    const counts = new Map<string, number>();
    for (const { failure } of SOLVER_FAILURE_DISPOSITIONS) {
      counts.set(failure, (counts.get(failure) ?? 0) + 1);
    }
    const shared = [...counts.entries()].filter(([, n]) => n > 1).map(([token]) => token);
    expect(shared).toEqual(['objective-overflow']);
  });
});
