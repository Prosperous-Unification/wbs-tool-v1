import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

// TASK-160. configure.sh travels to the host alone, so its Caddy provisioning
// is inlined rather than read from deploy/compose/. That duplication is the
// point of these assertions: the two copies are free to drift, and the way
// they drift is one of them quietly going back to a per-vhost log block.
const configureSh = readFileSync(join(import.meta.dir, 'configure.sh'), 'utf8');
const bootstrapCaddyfile = readFileSync(
  join(import.meta.dir, '../../../deploy/compose/Caddyfile.bootstrap'),
  'utf8',
);
const logRedact = readFileSync(
  join(import.meta.dir, '../../../deploy/compose/log-redact.caddy'),
  'utf8',
);

describe('configure.sh Caddy provisioning', () => {
  it('installs the access-log snippet the site files import', () => {
    expect(configureSh).toContain('$WBS_ROOT/caddy/log-redact.caddy');
    expect(configureSh).toContain('(access-log) {');
  });

  it('seeds site.caddy importing that snippet, not its own log block', () => {
    expect(configureSh).toContain('import access-log');
    // The single legitimate `output file` is inside the snippet's own
    // definition; a second one is a vhost logging around the filter.
    expect(configureSh.match(/output file \/var\/log\/caddy/g)).toHaveLength(1);
  });

  it('redacts every credential-shaped query parameter the snippet file does', () => {
    // Derived from the snippet rather than listed here: a hand-written list
    // cannot fail when a parameter is added to one copy and not the other,
    // which is the only way these two ever drift.
    const params = [...logRedact.matchAll(/replace\s+(\S+)\s+REDACTED/g)].map((m) => m[1]);
    expect(params.length).toBeGreaterThanOrEqual(13);
    for (const param of params) {
      expect(configureSh, `configure.sh redacts ${param}`).toContain(`replace ${param} REDACTED`);
    }
  });

  it('imports log-redact.caddy before site.caddy, in both copies', () => {
    // Comments in both files quote `import site.caddy` while explaining the
    // history, so this reads the lines that actually get emitted rather than
    // the first occurrence of the string anywhere in the file.
    const emitted = (text: string): string[] =>
      text
        .split('\n')
        .map((l) => l.replace(/^\s*printf '(.*)\\n'\s*$/, '$1').trim())
        .filter((l) => /^import\s+\S+$/.test(l));

    // Only the block that writes the Caddyfile. The whole script also contains
    // the `import access-log` line of the site.caddy seed, which is a snippet
    // import inside a vhost, not a top-level Caddyfile import.
    const caddyfileBlock = configureSh.slice(
      configureSh.indexOf('caddy_tmp='),
      configureSh.indexOf('mv "$caddy_tmp" "$caddyfile"'),
    );
    expect(caddyfileBlock.length).toBeGreaterThan(0);

    for (const [name, text] of [
      ['configure.sh', caddyfileBlock],
      ['Caddyfile.bootstrap', bootstrapCaddyfile],
    ] as const) {
      const lines = emitted(text);
      const redact = lines.indexOf('import log-redact.caddy');
      const site = lines.indexOf('import site.caddy');
      expect(redact, `${name} emits import log-redact.caddy`).toBeGreaterThanOrEqual(0);
      expect(site, `${name} emits import site.caddy`).toBeGreaterThanOrEqual(0);
      expect(redact, `${name} emits log-redact.caddy first`).toBeLessThan(site);
    }
  });

  it('preserves import lines it does not own instead of overwriting the Caddyfile', () => {
    // Five hand-added vhosts (registry, dev, monitoring, novel, studio) live in
    // the same Caddyfile. The previous unconditional single-line write would
    // have taken all five down on the next re-run.
    expect(configureSh).not.toMatch(/cat > "\$WBS_ROOT\/caddy\/Caddyfile"/);
    expect(configureSh).toContain("grep -E '^[[:space:]]*import[[:space:]]'");
  });
});
