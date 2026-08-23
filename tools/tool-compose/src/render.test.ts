import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { renderAll, renderTemplate } from './render';

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
