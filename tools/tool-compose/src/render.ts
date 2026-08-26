import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export type RenderContext = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(tmpl: string, ctx: RenderContext): string {
  return tmpl.replace(PLACEHOLDER, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(ctx, key)) {
      throw new Error(`Missing placeholder value for {{${key}}}`);
    }
    return ctx[key];
  });
}

export interface RenderAllOptions {
  templatesDir: string;
  outDir: string;
  context: RenderContext;
}

export async function renderAll(opts: RenderAllOptions): Promise<string[]> {
  const files = await readdir(opts.templatesDir, { recursive: true, withFileTypes: true });
  const written: string[] = [];
  for (const f of files) {
    if (!f.isFile()) continue;
    if (!f.name.endsWith('.tmpl')) continue;
    const parent: string =
      typeof (f as { parentPath?: unknown }).parentPath === 'string'
        ? (f as { parentPath: string }).parentPath
        : opts.templatesDir;
    const srcPath = join(parent, f.name);
    const content = await readFile(srcPath, 'utf8');
    const rendered = renderTemplate(content, opts.context);
    const rel = relative(opts.templatesDir, srcPath).replace(/\.tmpl$/, '');
    const dst = join(opts.outDir, rel);
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, rendered, 'utf8');
    written.push(dst);
  }
  return written;
}

function parseArgs(argv: string[]): { outDir: string } {
  const args: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m && typeof m[1] === 'string' && typeof m[2] === 'string') {
      args[m[1]] = m[2];
    }
  }
  return { outDir: args['outDir'] ?? 'dist/tools/tool-compose' };
}

// Preview/CLI defaults only — a real deploy never calls this. The swap
// executor (tools/tool-remote-scripts/src/swap.ts) renders both templates
// itself with real per-deploy values (digest-pinned image, actual routed
// colours) via `renderTemplate` directly, imported through `@wbs/tool-compose`.
export function previewContext(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RenderContext {
  // Whole-block route placeholders, matching site.caddy.tmpl (each is the
  // full content of a `handle { ... }` body, not just a colour — see
  // tools/tool-remote-scripts/src/lib/site.ts's `routeBlock`, which is what
  // a real deploy actually uses; this preview default just needs *some*
  // valid Caddyfile snippet per tier, deployed by default).
  return {
    CONTAINER: env['CONTAINER'] ?? 'be-01-blue',
    NETWORK: env['NETWORK'] ?? 'wbs-net',
    IMAGE: env['IMAGE'] ?? `registry.infra.bulletpoints.club/wbs-be-01@sha256:${'0'.repeat(64)}`,
    SITE_ADDRESS: env['SITE_ADDRESS'] ?? 'wbs.bulletpoints.club',
    BE_ROUTE: env['BE_ROUTE'] ?? 'reverse_proxy be-01-blue:3100',
    GW_ROUTE: env['GW_ROUTE'] ?? 'reverse_proxy gw-01-blue:3200',
    FE_ROUTE: env['FE_ROUTE'] ?? 'reverse_proxy fe-01-blue:80',
    MCP_ROUTES: env['MCP_ROUTES'] ?? '',
    // Whole-block placeholders, same shape lib/docker.ts's real
    // tierComposeContext produces (see its doc comment) — a preview default
    // just needs *some* valid env_file entry, not the real per-tier
    // allowlisting a real deploy applies.
    ENV_FILES: env['ENV_FILES'] ?? '    env_file:\n      - /home/puni1/wbs/be-01.env\n',
    VOLUMES: env['VOLUMES'] ?? '    volumes:\n      - /home/puni1/wbs/data:/data\n',
  };
}

async function main(): Promise<void> {
  const { outDir } = parseArgs(process.argv.slice(2));
  const written = await renderAll({
    templatesDir: new URL('./templates', import.meta.url).pathname,
    outDir,
    context: previewContext(),
  });
  console.log(`rendered ${String(written.length)} file(s) into ${outDir}`);
}

if (import.meta.main) {
  void main();
}
