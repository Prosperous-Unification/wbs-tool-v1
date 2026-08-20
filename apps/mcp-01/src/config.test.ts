import { describe, expect, it } from 'bun:test';

import { loadConfig } from './config';

const FULL = {
  WBS_API_URL: 'https://dev.wbs.bulletpoints.club',
  WBS_TOKEN: 'token-abc',
  WBS_BASIC_AUTH: 'dany:hunter2',
};

describe('loadConfig', () => {
  it('returns the three variables when all are present', () => {
    const cfg = loadConfig(FULL);
    expect(cfg.WBS_API_URL).toBe('https://dev.wbs.bulletpoints.club');
    expect(cfg.WBS_TOKEN).toBe('token-abc');
    expect(cfg.WBS_BASIC_AUTH).toBe('dany:hunter2');
  });

  it('leaves WBS_BASIC_AUTH undefined when unset', () => {
    expect(loadConfig({ ...FULL, WBS_BASIC_AUTH: undefined }).WBS_BASIC_AUTH).toBeUndefined();
  });

  // Watched red for design.md D3: delete the `WBS_API_URL: 'string.url'` line,
  // or give it a `http://localhost:3100` default, and this test must fail —
  // that is the fault it exists to catch. A boot that defaults its base URL
  // edits whichever deployment answers.
  it('refuses to boot without WBS_API_URL, and names it', () => {
    expect(() => loadConfig({ ...FULL, WBS_API_URL: undefined })).toThrow(
      /WBS_API_URL is required/,
    );
  });

  it('refuses to boot without WBS_TOKEN, and names it', () => {
    expect(() => loadConfig({ ...FULL, WBS_TOKEN: undefined })).toThrow(/WBS_TOKEN is required/);
  });

  it('treats an empty variable as unset rather than as a value', () => {
    expect(() => loadConfig({ ...FULL, WBS_TOKEN: '' })).toThrow(/WBS_TOKEN is required/);
  });

  it('rejects a WBS_API_URL that is not a URL', () => {
    expect(() => loadConfig({ ...FULL, WBS_API_URL: 'dev.wbs.bulletpoints.club' })).toThrow(
      /WBS_API_URL is set but invalid/,
    );
  });

  it('rejects a WBS_BASIC_AUTH with no colon', () => {
    expect(() => loadConfig({ ...FULL, WBS_BASIC_AUTH: 'danyhunter2' })).toThrow(
      /WBS_BASIC_AUTH is set but invalid/,
    );
  });

  // The boot failure is the most likely thing anyone ever pastes into a chat
  // window or a log. It must not carry the token or the password. Swap the
  // narrow read in `loadConfig` for `defineConfig(McpConfig)` and this goes
  // red: `parseOrThrow` stringifies its whole input into the message.
  it('never puts a secret in the message it throws', () => {
    let message = '';
    try {
      loadConfig({ ...FULL, WBS_API_URL: 'not-a-url' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('WBS_API_URL');
    expect(message).not.toContain('token-abc');
    expect(message).not.toContain('hunter2');
  });
});
