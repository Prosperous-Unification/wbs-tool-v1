import { type } from '@wbs/validation';
import { describe, expect, it } from 'bun:test';

import { defineConfig } from './define-config';
import { LogLevel, Port } from './env-schemas';

describe('defineConfig', () => {
  it('parses env overrides correctly', () => {
    const cfg = defineConfig(type({ PORT: 'string.integer.parse', LOG_LEVEL: "'info'|'debug'" }), {
      PORT: '3100',
      LOG_LEVEL: 'info',
    });
    expect(cfg.PORT).toBe(3100);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('throws with a clear message when env is invalid', () => {
    expect(() =>
      defineConfig(type({ PORT: 'string.integer.parse' }), { PORT: 'not-a-port' }),
    ).toThrow(/PORT/);
  });

  it('names the variable that is wrong and prints no value of any of them', () => {
    // The env source is the whole environment, so a refusal that echoes it
    // prints every secret the process holds. This used to go through
    // `parseOrThrow`, whose message opened with `JSON.stringify(input)`.
    //
    // The bad variable is a **literal union** on purpose, and the schema is the
    // shape be-01 and gw-01 actually declare. Arktype's summary is safe for a
    // type mismatch (`must be a number (was a string)`) and quotes what it got
    // for a literal or a regex, so a union is the case that distinguishes
    // "stopped echoing the input" from "prints no value at all" — and it is the
    // case a mistyped LOG_LEVEL produces.
    //
    // Proof: with `defineConfig` put back to `parseOrThrow`, watched failing on
    // `expect(received).not.toContain(expected) · Expected to not contain:
    // "s3cret-signing-key-that-must-never-be-logged"` (2026-09-02). With
    // `parseOrThrow` merely stripped of its `JSON.stringify(input)` prefix it
    // still failed, on the `'verbose'` assertion below.
    const SIGNING_KEY = 's3cret-signing-key-that-must-never-be-logged';
    const SHARED = 'internal-shared-secret-nobody-may-see';
    let thrown = '';
    try {
      defineConfig(
        type({
          LOG_LEVEL: "'info'|'debug'",
          JWT_SIGNING_KEY_CURRENT: 'string>=32',
          INTERNAL_AUTH_SECRET: 'string>=32',
        }),
        {
          LOG_LEVEL: 'verbose',
          JWT_SIGNING_KEY_CURRENT: SIGNING_KEY,
          INTERNAL_AUTH_SECRET: SHARED,
        },
      );
    } catch (e) {
      thrown = e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e);
    }

    expect(thrown).toContain('LOG_LEVEL');
    expect(thrown).not.toContain(SIGNING_KEY);
    expect(thrown).not.toContain(SHARED);
    // The offending value is a value too, and it is the one arktype quotes.
    expect(thrown).not.toContain('verbose');
  });
});

describe('env-schemas', () => {
  it('Port accepts valid TCP ports', () => {
    const result = Port('3000');
    expect(result).toBe(3000);
  });

  it('Port rejects 0 and out-of-range values', () => {
    const tooHigh = Port('70000');
    expect(typeof tooHigh).toBe('object');
    const zero = Port('0');
    expect(typeof zero).toBe('object');
  });

  it('LogLevel accepts the known levels', () => {
    expect(LogLevel('info')).toBe('info');
  });
});
