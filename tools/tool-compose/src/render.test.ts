import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { previewContext, renderAll, renderTemplate } from './render';

const TEMPLATES = join(import.meta.dir, 'templates');

describe('renderTemplate', () => {
  it('substitutes {{KEY}} placeholders', () => {
    const result = renderTemplate('port {{PORT}}, host {{HOST}}', {
      PORT: '3100',
      HOST: 'localhost',
    });
    expect(result).toBe('port 3100, host localhost');
  });

  it('throws on missing placeholder', () => {
    expect(() => renderTemplate('missing {{FOO}}', {})).toThrow(/FOO/);
  });
});

describe('previewContext', () => {
  it('supplies an empty MCP route block for the build preview', () => {
    expect(previewContext({})).toMatchObject({ MCP_ROUTES: '' });
  });
});

describe('renderAll', () => {
  it('renders all .tmpl files under templates/ into outDir', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'tool-compose-'));
    const written = await renderAll({
      templatesDir: join(import.meta.dir, 'templates'),
      outDir,
      context: {
        CONTAINER: 'be-01-green',
        NETWORK: 'wbs-net',
        IMAGE: 'registry.infra.bulletpoints.club/wbs-be-01:abc1234',
        SITE_ADDRESS: 'wbs.bulletpoints.club',
        BE_ROUTE: 'reverse_proxy be-01-green:3100',
        GW_ROUTE: 'reverse_proxy gw-01-blue:3200',
        FE_ROUTE: 'reverse_proxy fe-01-green:80',
        MCP_ROUTES: '',
        ENV_FILES:
          '    env_file:\n      - /home/puni1/wbs/be-01.env\n      - /home/puni1/wbs/be-01.secrets.env\n',
        VOLUMES: '    volumes:\n      - /home/puni1/wbs/data:/data\n',
      },
    });
    expect(written.length).toBeGreaterThan(0);
    const tier = await readFile(join(outDir, 'tier.compose'), 'utf8');
    expect(tier).toMatch(/image: registry.infra.bulletpoints.club\/wbs-be-01:abc1234/);
    expect(tier).toMatch(/be-01-green:/);
    expect(tier).toMatch(/- \/home\/puni1\/wbs\/be-01\.secrets\.env/);
    expect(tier).toContain('driver: json-file');
    expect(tier).toContain("max-size: '20m'");
    expect(tier).toContain("max-file: '3'");
    const site = await readFile(join(outDir, 'site.caddy'), 'utf8');
    expect(site).toMatch(/reverse_proxy be-01-green:3100/);
  });
});

describe('site.caddy.tmpl', () => {
  const tmpl = readFileSync(join(TEMPLATES, 'site.caddy.tmpl'), 'utf8');

  it('renders with every placeholder supplied', () => {
    const out = renderTemplate(tmpl, {
      SITE_ADDRESS: 'wbs.bulletpoints.club',
      BE_ROUTE: 'reverse_proxy be-01-green:3100',
      GW_ROUTE: 'reverse_proxy gw-01-blue:3200 {\n\t\t\tstream_close_delay 310s\n\t\t}',
      FE_ROUTE: 'reverse_proxy fe-01-green:80',
      MCP_ROUTES: '',
    });
    expect(out).toContain('be-01-green:3100');
    expect(out).toContain('gw-01-blue:3200');
    expect(out).toContain('fe-01-green:80');
    expect(out).toContain('stream_close_delay 310s');
    expect(out).not.toContain('{{');
  });

  // The GW_COLOR-literal stream_close_delay directive moved out of the raw
  // .tmpl file and into lib/site.ts's routeBlock() (see that file's own
  // test) once each route became a whole-block placeholder rather than a
  // bare colour substitution — that's what makes an honestly-omitted
  // "not yet deployed" route possible at all. The property itself (a real,
  // deployed gw route always carries stream_close_delay) is covered there
  // now, not against the raw template text.
  it('passes /api through rather than stripping it', () => {
    // handle_path would strip /api, but be-01 mounts its controllers under /api.
    expect(tmpl).not.toContain('handle_path /api');
    expect(tmpl).toContain('handle /api/*');
  });
});

// TASK-160. The rendered site config is written wholesale by every blue/green
// swap over BOTH vhosts, so a per-vhost `log { output file … }` block here is
// not a style preference — it is the leak TASK-159 closed reopening itself on
// the next swap, silently, with a config Caddy accepts happily.
describe('site.caddy.tmpl access logging', () => {
  const tmpl = readFileSync(join(TEMPLATES, 'site.caddy.tmpl'), 'utf8');

  it('imports the one shared access-log snippet', () => {
    expect(tmpl).toContain('import access-log');
  });

  it('never defines an access-log output of its own', () => {
    expect(tmpl).not.toContain('output file /var/log/caddy');
    expect(tmpl).not.toMatch(/^\s*log\s*\{/m);
  });
});

// TASK-160. The template was the reported carrier; two more were found only by
// grepping, and a third — deploy/compose/site-dev.caddy.candidate, the staged
// replacement for the very vhost the 10,901 JWTs came from — was found only by
// a reviewer, because the first grep ran against a stale checkout. A sweep is
// cheaper than remembering to grep. Every Caddy site file this repo ships must
// import the shared filter rather than open the log itself; the only file
// allowed to name the output is the snippet that defines it.
describe('no vhost this repo ships opens the access log itself', () => {
  const DEPLOY = join(import.meta.dir, '../../../deploy/compose');
  const SNIPPET = 'log-redact.caddy';

  const caddyFiles = readdirSync(DEPLOY).filter((f) => f.includes('.caddy'));

  it('finds the site files to check (a passing empty sweep proves nothing)', () => {
    expect(caddyFiles).toContain(SNIPPET);
    expect(caddyFiles.length).toBeGreaterThan(1);
  });

  for (const file of caddyFiles) {
    if (file === SNIPPET) continue;
    it(`${file} imports access-log instead of defining an output`, () => {
      const text = readFileSync(join(DEPLOY, file), 'utf8');
      // Unconditional: `log unredacted { output file … }` is valid Caddy, and a
      // named logger would slip past a check that only looks for a bare `log {`.
      // Naming the shared file at all, under any logger name, is the defect.
      expect(text).not.toContain('output file /var/log/caddy');
      // `log` optionally takes a logger name before its block.
      const definesLogging = /^\s*log(\s+\S+)?\s*\{/m.test(text);
      if (!definesLogging && !text.includes('import access-log')) {
        // A site file with no logging at all is fine — registry.caddy is one.
        return;
      }
      expect(text).toContain('import access-log');
      expect(definesLogging).toBeFalse();
    });
  }
});
