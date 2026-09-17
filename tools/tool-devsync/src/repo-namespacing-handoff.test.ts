import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// tool-devsync's `build` target runs shellcheck over `bin/*.sh` and bundles no TypeScript, so the
// buildable-library half of the boundary rule has no output to protect here. The half that does
// apply — `scope:infra` may reach `product:shared` — holds, and workspace-projects.test.ts checks
// it against the real Nx graph.
// eslint-disable-next-line @nx/enforce-module-boundaries -- no TypeScript build to protect
import { parseOrThrow, type } from '@shared/validation';
import { expect, test } from 'bun:test';

import { readProjects } from '../workspace-projects.mjs';

const WORKSPACE = fileURLToPath(new URL('../../../', import.meta.url));
const LEGACY_ROOT =
  /(?:apps\/(?:be-01|fe-01|gw-01|mcp-01|\*+|\$\{[^}]+\})|libs\/(?:auth|config|conformance|contracts|core|domain|observability|realtime|runtime-portable|solver-py|store-memory|store-sqlite|validation|\*+|\$\{[^}]+\}))(?:\/|\b)/g;

/**
 * The one OpenSpec change whose packet is read as current prose rather than as a record of
 * what was once done. Every other unarchived packet keeps its own pre-move evidence in
 * `tasks.md` and `verify.md`, so the tree as a whole is not a source of current paths.
 */
const ACTIVE_OPENSPEC_PACKET = 'openspec/changes/automatic-dev-solver-binding/';

/**
 * What the three per-document checks need to run: the tracked tree and the real Nx project
 * names, plus every product those projects declare, which the alias-prefix rule reads.
 */
interface DocumentContext {
  readonly candidates: ReadonlySet<string>;
  readonly projectNames: ReadonlySet<string>;
  readonly products: ReadonlySet<string>;
}

async function documentContext(
  candidates: ReadonlySet<string> = new Set(candidatePaths()),
): Promise<DocumentContext> {
  const projects = await readProjects(WORKSPACE);
  return {
    candidates,
    projectNames: new Set(projects.map(({ name }) => name)),
    products: new Set(
      projects.flatMap(({ tags }) =>
        tags.filter((tag) => tag.startsWith('product:')).map((tag) => tag.slice('product:'.length)),
      ),
    ),
  };
}

/**
 * Every check a current document has to pass, each reporting what it found in **one** document.
 * An exemption names the checks it excuses, so excusing a stale `nx` selector never also excuses
 * a pre-move path or a dead link in the same file.
 */
const DOCUMENT_CHECKS = {
  'legacy-root': legacyRootFailures,
  'nx-selector': staleSelectorFailures,
  links: localLinkFailures,
} as const satisfies Record<string, (path: string, context: DocumentContext) => Promise<string[]>>;

type DocumentCheck = keyof typeof DOCUMENT_CHECKS;

const DOCUMENT_CHECK_NAMES = Object.keys(DOCUMENT_CHECKS) as DocumentCheck[];

const CheckExemptions = type({
  expires: /^\d{4}-\d{2}-\d{2}$/,
  entries: type({
    path: 'string>0',
    reason: 'string>0',
    excuses: type
      .enumerated(...DOCUMENT_CHECK_NAMES)
      .array()
      .atLeastLength(1),
  }).array(),
});

/**
 * The documents exempted from named current-document checks, each with why it is frozen and which
 * checks it escapes. Malformed or absent content throws rather than silently exempting nothing —
 * an empty file would let every stale reference read as current and pass. The check names are
 * taken from {@link DOCUMENT_CHECKS}, so an unknown or empty `excuses` is refused here.
 */
async function readCheckExemptions(): Promise<typeof CheckExemptions.infer> {
  const path = join(WORKSPACE, 'docs/findings/current-document-check-exemptions.json');
  // Proof: deleting the file failed every consumer here with `ENOENT ... open
  // '<workspace>/docs/findings/current-document-check-exemptions.json'`; replacing `entries` with
  // `{}` failed with `Validation failed: entries must be an array (was object)`; an `excuses: []`
  // failed with `value at [0].excuses must be non-empty` and an `excuses: ['nope']` with
  // `must be "legacy-root", "links" or "nx-selector" (was "nope")` (2026-09-15).
  return parseOrThrow(CheckExemptions, JSON.parse(await readFile(path, 'utf8')));
}

/** The documents whose entry excuses `check` — and no document excused only from another check. */
async function exemptedFrom(check: DocumentCheck): Promise<Set<string>> {
  const { entries } = await readCheckExemptions();
  return new Set(entries.filter(({ excuses }) => excuses.includes(check)).map(({ path }) => path));
}

/** Every tracked Markdown a reader is expected to act on today. */
function documentCandidates(candidates: Iterable<string>): string[] {
  return [...candidates].filter(
    (path) =>
      path.endsWith('.md') &&
      (path.startsWith('docs/') || !path.includes('/') || path.startsWith(ACTIVE_OPENSPEC_PACKET)),
  );
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else files.push(path);
  }
  return files.sort();
}

function gitBlob(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest('hex');
}

function candidatePaths(): string[] {
  const invocation = Bun.spawnSync(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: WORKSPACE,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (invocation.exitCode !== 0) {
    throw new Error(
      `cannot enumerate candidate source: ${new TextDecoder().decode(invocation.stderr)}`,
    );
  }
  return new TextDecoder().decode(invocation.stdout).split('\0').filter(Boolean);
}

async function currentDocuments(
  rootRouterSource?: string,
  candidates = new Set(candidatePaths()),
): Promise<string[]> {
  const readmes = [...candidates].filter(
    (path) =>
      path.endsWith('/README.md') &&
      (path.startsWith('apps/') || path.startsWith('libs/') || path.startsWith('tools/')),
  );
  const rootRouted = (await rootRoutedDocuments(rootRouterSource, candidates)).filter((path) =>
    candidates.has(path),
  );
  return [...new Set([...documentCandidates(candidates), ...rootRouted, ...readmes])].sort();
}

async function legacyRootFailures(path: string): Promise<string[]> {
  const source = await readFile(join(WORKSPACE, path), 'utf8');
  return [...source.matchAll(LEGACY_ROOT)].map((match) => `${path}:${match[0]}`);
}

async function staleSelectorFailures(path: string, context: DocumentContext): Promise<string[]> {
  const failures: string[] = [];
  const lines = (await readFile(join(WORKSPACE, path), 'utf8')).split('\n');
  for (const [offset, line] of lines.entries()) {
    if (line.includes('historical path)')) continue;
    const commandSelectors = [
      ...line.matchAll(/\bnx run ([a-z0-9-]+):/g),
      ...line.matchAll(/\bnx (?:test|lint|build|typecheck) ([a-z0-9-]+)/g),
    ];
    for (const match of commandSelectors) {
      if (!context.projectNames.has(match[1])) {
        failures.push(`${path}:${String(offset + 1)}:${match[1]}`);
      }
    }
  }
  return failures;
}

async function rootRoutedDocuments(
  rootRouterSource?: string,
  candidates = new Set(candidatePaths()),
): Promise<string[]> {
  const source = rootRouterSource ?? (await readFile(join(WORKSPACE, 'LLM_README.md'), 'utf8'));
  const destinations = [
    ...localMarkdownDestinations(source),
    ...[...source.matchAll(/`([^`\s]+\.md)`/g)].map((match) => match[1]),
  ];
  const routed: string[] = [];
  for (const destination of destinations) {
    const path = decodeURIComponent(destination.split(/[?#]/, 1)[0]).replace(/^\//, '');
    const isExplicitRoute =
      !/[{}*?[\]]/.test(path) &&
      (/^(?:apps|docs|libs|openspec|tools)\//.test(path) ||
        path === 'AGENTS.md' ||
        path === 'HUMAN_README.md');
    if (!isExplicitRoute) continue;
    const candidate = candidates.has(`${path}/README.md`) ? `${path}/README.md` : path;
    if (candidate.endsWith('.md')) routed.push(candidate);
  }
  return [...new Set(routed)].sort();
}

function localMarkdownDestinations(source: string): string[] {
  const destinations: string[] = [];
  for (const match of source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
    destinations.push(match[1].replace(/^<|>$/g, ''));
  }
  for (const match of source.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)) {
    destinations.push(match[1].replace(/^<|>$/g, ''));
  }
  return destinations.filter(
    (destination) => !/^[a-z][a-z0-9+.-]*:/i.test(destination) && !destination.startsWith('//'),
  );
}

function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const collisions = new Map<string, number>();
  for (const match of source.matchAll(
    /<(?:a|[a-z][a-z0-9-]*)\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/gi,
  )) {
    anchors.add(match[1]);
  }
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const visible = match[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .toLocaleLowerCase('en-US');
    const base = visible
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const collision = collisions.get(base) ?? 0;
    collisions.set(base, collision + 1);
    anchors.add(collision === 0 ? base : `${base}-${String(collision)}`);
  }
  return anchors;
}

async function localLinkFailures(sourcePath: string, context: DocumentContext): Promise<string[]> {
  const { candidates } = context;
  const failures: string[] = [];
  const source = await readFile(join(WORKSPACE, sourcePath), 'utf8');
  for (const destination of localMarkdownDestinations(source)) {
    const hashAt = destination.indexOf('#');
    const encodedPath = hashAt === -1 ? destination : destination.slice(0, hashAt);
    const encodedAnchor = hashAt === -1 ? '' : destination.slice(hashAt + 1);
    const decodedPath = decodeURIComponent(encodedPath.split('?', 1)[0]);
    let targetPath =
      decodedPath.length === 0
        ? sourcePath
        : decodedPath.startsWith('/')
          ? posix.normalize(decodedPath.slice(1))
          : posix.normalize(posix.join(posix.dirname(sourcePath), decodedPath));
    if (!candidates.has(targetPath) && candidates.has(`${targetPath}/README.md`)) {
      targetPath = `${targetPath}/README.md`;
    }
    if (!candidates.has(targetPath)) {
      failures.push(`${sourcePath} -> ${destination} (absent ${targetPath})`);
      continue;
    }
    if (encodedAnchor.length === 0 || !targetPath.endsWith('.md')) continue;
    const anchors = documentAnchors(await readFile(join(WORKSPACE, targetPath), 'utf8'));
    const anchor = decodeURIComponent(encodedAnchor);
    if (!anchors.has(anchor)) failures.push(`${sourcePath} -> ${destination} (absent #${anchor})`);
  }
  return failures;
}

/** Every failure `check` finds across the current documents it is not excused from. */
async function currentDocumentFailures(
  check: DocumentCheck,
  context: DocumentContext,
  rootRouterSource?: string,
): Promise<string[]> {
  const exempted = await exemptedFrom(check);
  const failures: string[] = [];
  for (const path of await currentDocuments(rootRouterSource, new Set(context.candidates))) {
    if (exempted.has(path)) continue;
    failures.push(...(await DOCUMENT_CHECKS[check](path, context)));
  }
  return failures;
}

async function currentDocumentLinkFailures(
  rootRouterSource?: string,
  candidates = new Set(candidatePaths()),
): Promise<string[]> {
  const failures: string[] = [];
  for (const routedPath of await rootRoutedDocuments(rootRouterSource, candidates)) {
    if (!candidates.has(routedPath)) {
      failures.push(`LLM_README.md -> ${routedPath} (absent ${routedPath})`);
    }
  }
  const context = await documentContext(candidates);
  failures.push(...(await currentDocumentFailures('links', context, rootRouterSource)));
  return failures;
}

function isRelevantSourceConfig(path: string): boolean {
  if (
    path === 'tools/tool-devsync/src/repo-namespacing-handoff.test.ts' ||
    path.endsWith('/README.md') ||
    path.endsWith('.md')
  ) {
    return false;
  }
  const basename = posix.basename(path);
  const isConfigurationName =
    basename === 'Dockerfile' ||
    basename.endsWith('.Dockerfile') ||
    basename.startsWith('Caddyfile') ||
    /^\.[a-z0-9.-]+$/i.test(basename);
  const isTextExtension =
    /\.(?:[cm]?[jt]sx?|py|sh|json|ya?ml|toml|ini|conf|service|caddy|sql)$/i.test(path);
  const isOwnedFamily =
    /^(?:\.github|apps|libs|tools|bin|deploy|ops)\//.test(path) ||
    path.startsWith('docs/wiki-policy/') ||
    !path.includes('/');
  return isOwnedFamily && (isConfigurationName || isTextExtension || path.startsWith('bin/'));
}

async function legacySourceOccurrences(): Promise<{
  categories: Record<string, number>;
  coverage: {
    applicationLibraryToolReadmes: number;
    dockerfiles: string[];
    extensionlessScripts: boolean;
    policyJson: boolean;
    python: boolean;
  };
  digest: string;
  occurrences: number;
  unclassified: string[];
}> {
  const contexts: string[] = [];
  const categories: Record<string, number> = {};
  const unclassified: string[] = [];
  const relevantPaths = candidatePaths().filter(isRelevantSourceConfig);
  for (const path of relevantPaths) {
    const lines = (await readFile(join(WORKSPACE, path), 'utf8')).split('\n');
    for (const [offset, line] of lines.entries()) {
      for (const match of line.matchAll(LEGACY_ROOT)) {
        const context = `${path}:${String(offset + 1)}:${match[0]}:${line.trim()}`;
        contexts.push(context);
        const category = /^(?:apps|libs)\/\*+\//.test(match[0])
          ? 'current recursive selector'
          : path.includes('/drizzle/') && path.endsWith('.sql')
            ? 'frozen migration evidence'
            : /(?:\.test\.[^/]+|\.test\.sh)$/.test(path) || path.includes('/fixtures/')
              ? 'test fixture or proof'
              : [
                    'docs/wiki-policy/bootstrap-policy.json',
                    'docs/wiki-policy/modules.bootstrap.json',
                    'docs/wiki-policy/relationships.bootstrap.json',
                  ].includes(path)
                ? 'historical bootstrap policy or mapping'
                : path === 'docs/wiki-policy/policy.json'
                  ? 'historical policy selector or baseline'
                  : [
                        '.dockerignore',
                        '.github/workflows/ci.yml',
                        'apps/wiki/cli/src/admission/authority-store.ts',
                        'apps/wiki/cli/src/admission/claims.ts',
                        'apps/wiki/cli/src/contracts/records.ts',
                        'lefthook.yml',
                        'tools/tool-dagger/src/main.ts',
                        'tools/tool-deploy/src/migrations.ts',
                        'tools/tool-git-hooks/src/hooks/corpus-version-lint.ts',
                      ].includes(path)
                    ? 'production proof or revision transition'
                    : 'UNCLASSIFIED';
        categories[category] = (categories[category] ?? 0) + 1;
        if (category === 'UNCLASSIFIED') unclassified.push(context);
      }
    }
  }
  contexts.sort();
  return {
    categories,
    coverage: {
      applicationLibraryToolReadmes: (await currentDocuments()).filter(
        (path) =>
          path.endsWith('/README.md') &&
          (path.startsWith('apps/') || path.startsWith('libs/') || path.startsWith('tools/')),
      ).length,
      dockerfiles: relevantPaths.filter((path) => {
        const basename = posix.basename(path);
        return basename === 'Dockerfile' || basename.endsWith('.Dockerfile');
      }),
      extensionlessScripts: relevantPaths.includes('bin/dev-ports.sh'),
      policyJson: relevantPaths.includes('docs/wiki-policy/policy.json'),
      python: relevantPaths.some((path) => path.endsWith('.py')),
    },
    digest: createHash('sha256').update(JSON.stringify(contexts)).digest('hex'),
    occurrences: contexts.length,
    unclassified,
  };
}

test('current documentation and active solver packets use namespaced roots', async () => {
  // The documents that record a pre-move path as evidence — the root-source block and the
  // 2026-08-31 runbook incident among them — carry a `legacy-root` exemption instead of a second
  // list here; changing one of them rewrites evidence rather than repairing navigation.
  // Proof: rewriting the root-source path to its current namespace made root-migration.test.ts
  // fail 14 cases behind the exact router.landmines.001 payload mismatch (2026-09-14).
  // Proof: adding `` see `libs/domain/src/x.ts` `` to docs/capacity.md failed here naming
  // `docs/capacity.md:libs/domain/`, the discovered document that carries no excuse (2026-09-15).
  expect(await currentDocumentFailures('legacy-root', await documentContext())).toEqual([]);
});

test('current Nx commands select existing qualified projects', async () => {
  // Proof: the pre-review current commands named `be-01`, `gw-01`, `fe-01`, and `validation`;
  // this oracle failed with their five exact locations instead of trusting path-only checks.
  // Proof: appending `` run `bunx nx test fe-01` first. `` to docs/local-dev.md — exempted from
  // `legacy-root` and nothing else — failed here with `docs/local-dev.md:168:fe-01`, so a
  // pre-move-path exemption does not also switch this check off for that document (2026-09-15).
  expect(await currentDocumentFailures('nx-selector', await documentContext())).toEqual([]);
});

test('the production index checker resolves current Markdown links and anchors', () => {
  const cli = fileURLToPath(new URL('../../../apps/wiki/cli/src/cli.ts', import.meta.url));
  const invocation = Bun.spawnSync(
    [process.execPath, 'run', cli, 'check-indexes', 'working', WORKSPACE, 'HEAD'],
    { cwd: WORKSPACE, env: process.env, stdout: 'pipe', stderr: 'pipe' },
  );

  // Proof: replacing the findings index link with `current.md#missing` made this actual-candidate
  // check exit 1 with `Markdown anchor absent ... #missing` (2026-09-14).
  expect(new TextDecoder().decode(invocation.stderr)).toBe('');
  expect(invocation.exitCode).toBe(0);
}, 30_000);

test('every routed current document resolves its local links and anchors', async () => {
  // Proof: adding `[fault](missing-round-one.md)` to non-index guide docs/capacity.md made this
  // complete current-document reader fail with its exact source, destination, and absent path.
  // Proof: adding a missing link to newly discovered docs/runbook-prod-deploy.md failed with its
  // exact routed source/destination, proving root discovery feeds this reader (2026-09-14).
  expect(await currentDocumentLinkFailures()).toEqual([]);
});

test('absent inline-code root routes survive extraction', async () => {
  const missingRoute = 'docs/missing-runbook.md';
  const rootRouter = '`docs/runbook-prod-deploy.md` -> `docs/missing-runbook.md`';
  const candidates = new Set(candidatePaths());

  // Proof: injecting this absent inline-code destination into the root router returned only
  // the 18 existing routes until extraction stopped filtering destinations by candidate membership.
  expect(await rootRoutedDocuments(rootRouter, candidates)).toContain(missingRoute);
});

test('absent inline-code root routes fail validation by exact name', async () => {
  const missingRoute = 'docs/missing-runbook.md';
  const rootRouter = '`docs/runbook-prod-deploy.md` -> `docs/missing-runbook.md`';
  const candidates = new Set(candidatePaths());

  // Proof: the injected missing route previously produced no link failures; this exact
  // LLM_README.md diagnostic failed until routed destinations were validated before reads.
  expect(await currentDocumentLinkFailures(rootRouter, candidates)).toContain(
    `LLM_README.md -> ${missingRoute} (absent ${missingRoute})`,
  );
});

test('every Dockerfile naming variant participates in source inventory', () => {
  const dockerfile = /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile)$/;
  const candidates = candidatePaths().filter((path) => dockerfile.test(path));
  const inventoried = candidatePaths()
    .filter(isRelevantSourceConfig)
    .filter((path) => dockerfile.test(path));

  // Proof: exact-basename matching omitted solver-orphan-fixture.Dockerfile from this manifest;
  // this test failed with that exact missing app path before suffix matching was added.
  expect(inventoried).toEqual(candidates);
});

test('every alias has an allowed prefix and resolves to a tracked file', async () => {
  const base = JSON.parse(await readFile(join(WORKSPACE, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const { candidates: tracked, products } = await documentContext();
  // The scopes an alias may carry: the two product-less ones plus one per declared product.
  // Derived rather than listed, so a second product's aliases need no edit here.
  const scopes = new Set(['shared', 'tools', ...products]);
  const failures: string[] = [];
  for (const [alias, targets] of Object.entries(base.compilerOptions.paths)) {
    const scope = /^@([a-z0-9-]+)\//.exec(alias)?.[1];
    if (scope === undefined) failures.push(`${alias}: prefix`);
    else if (!scopes.has(scope)) failures.push(`${alias}: no product named ${scope}`);
    for (const target of targets) {
      const path = target.replace(/^\.\//, '').replace(/\/\*$/, '');
      const exists = tracked.has(path) || [...tracked].some((file) => file.startsWith(`${path}/`));
      if (!exists) failures.push(`${alias}: ${target} is not tracked`);
    }
  }

  // Proof: on 2026-09-15 this rule found two dead aliases in the real tsconfig.base.json —
  // `@wbs/be-01` and `@wbs/gw-01`, each naming an `src/index.ts` no application has and imported
  // nowhere — and stayed red until Task 1.7 deleted them; injecting `@wbs/config` ->
  // ./libs/wbs/adapters/config/src/missing.ts adds `@wbs/config: ... is not tracked`, and an
  // `@acme/x` -> ./libs/acme/src/index.ts alias adds both a scope failure and its untracked
  // target.
  // Proof: with the scopes derived from the real project tags, injecting that `@acme/x` alias
  // into tsconfig.base.json failed here with `+ "@acme/x: no product named acme"` and
  // `+ "@acme/x: ./libs/acme/src/index.ts is not tracked"`; reverting the alias returned the
  // case to green (2026-09-16).
  expect(failures).toEqual([]);
});

test('every migration keeps its expected namespaced path and Git blob', async () => {
  const inventory = await readFile(
    join(WORKSPACE, 'openspec/changes/repo-namespacing/preflight-inventory.md'),
    'utf8',
  );
  const expected = [...inventory.matchAll(/^([0-9a-f]{40}) apps\/be-01\/drizzle\/(.+)$/gm)]
    .map(([, blob, suffix]) => [`apps/wbs/be-01/drizzle/${suffix}`, blob] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const migrationRoot = join(WORKSPACE, 'apps/wbs/be-01/drizzle');
  const observed = await Promise.all(
    (await filesBelow(migrationRoot)).map(async (path) => {
      const workspacePath = relative(WORKSPACE, path);
      return [workspacePath, gitBlob(await readFile(path))] as const;
    }),
  );

  // Proof: omitting one moved `down.sql` made this actual-candidate manifest fail with the exact
  // absent path while retaining the other 91 path/blob tuples (2026-09-14).
  expect(observed).toEqual(expected);
});

test('every legacy source occurrence and relevant text family is pinned', async () => {
  // Proof: injecting executable `const roundOneFault = 'apps/be-01/src'` into the already
  // classified tool-dagger main changed the pinned occurrence count/digest and failed this test.
  // Proof: changing solver-orphan-fixture.Dockerfile line 4 to `COPY apps/be-01/...` failed with
  // that exact UNCLASSIFIED context, count 262, and digest 116ba02b... (2026-09-14).
  expect(await legacySourceOccurrences()).toEqual({
    categories: {
      'current recursive selector': 31,
      'frozen migration evidence': 19,
      'historical bootstrap policy or mapping': 44,
      'historical policy selector or baseline': 39,
      'production proof or revision transition': 18,
      'test fixture or proof': 106,
    },
    coverage: {
      // Re-pinned 17 -> 18 when `apps/wiki/consumer/README.md` landed: the consumer template's
      // README is a real application README the sweep must cover, not an exemption.
      applicationLibraryToolReadmes: 18,
      dockerfiles: [
        'apps/wbs/be-01/Dockerfile',
        'apps/wbs/be-01/scripts/solver-orphan-fixture.Dockerfile',
        'apps/wbs/fe-01/Dockerfile',
        'apps/wbs/gw-01/Dockerfile',
        'deploy/dev-src/Dockerfile',
      ],
      extensionlessScripts: true,
      policyJson: true,
      python: true,
    },
    // Proof: leaving the pre-extraction digest here failed this test with the
    // observed `1f86dba5...` against the same occurrence count, because every
    // context carries its line number and the extraction shifted the recursive
    // selectors in workspace-inventory.test.ts down (2026-09-15).
    // Proof: leaving `1f86dba5.../262/23` here after the product lint policy moved out of
    // the root config failed on the observed `e705fb7a.../269/30` — the seven new
    // `apps/*/eslint.product.mjs` and `libs/*/eslint.product.mjs` selectors in nx.json and
    // lint-policy-cache.test.ts, all classified, none unclassified.
    // Proof: leaving `e705fb7a...` here after discovery moved into product-policies.mjs failed
    // on the observed `ae034489...` at the same 269/30 — the new nx.json and cache-test lines
    // carry no selector of their own and only shift the ones below them (2026-09-15).
    // Proof: leaving `ae034489...` here after the exemptions input joined this project's test
    // inputs failed on the observed `61b47ae3...` at the same 269/30 — the new
    // `{workspaceRoot}/docs/findings/current-document-check-exemptions.json` line carries no
    // selector of its own and only shifts the `apps/**` and `libs/**` ones below it. Renaming
    // that line later left the digest at `61b47ae3...`, since the line count did not move
    // (2026-09-15).
    // Proof: leaving `61b47ae3...` here after `@shared/validation` joined fe-01's two alias
    // maps and the required-alias assertion failed on the observed digest below at the same
    // 269/30 — the added entries carry no selector of their own and only shift the legacy
    // `../../libs/*` and `apps/libs/*` contexts in vite-config.test.ts below them (2026-09-16).
    // Proof: leaving `c29abd13.../269/98` here after the Tool Wiki relocation negative in
    // pilot-policy.test.ts pinned the refusal text `... (selector prefix libs/domain/src/saved-plan)`
    // failed on the observed digest below at 270/99 — one more classified `test fixture or proof`
    // context, none unclassified (2026-09-16).
    // Proof: leaving `0bc68474.../270/99` here after the three bootstrap wiki-policy files were
    // re-pointed at the moved pilot boundaries failed on the observed digest below at 253/102 —
    // 21 `historical bootstrap policy or mapping` contexts left bootstrap-policy.json,
    // modules.bootstrap.json and relationships.bootstrap.json, while the new on-disk bootstrap
    // oracle in pilot-policy.test.ts added three `test fixture or proof` contexts and one
    // `current recursive selector`, none unclassified (2026-09-16).
    // Proof: leaving `d0b34171.../253/102` here after tool-wiki became apps/wiki/cli failed on
    // `ab3010e6...` at the same 253/102 — every context that project carries kept its match and
    // its category and only changed the path it is reported under, which re-sorted the list.
    // Pinning `ab3010e6...` then failed on the observed digest below, still at 253/102, because
    // re-pinning the moved project's inventory counts in workspace-inventory.test.ts shifted the
    // four `apps/**`/`libs/**` selector contexts at the foot of that file.
    // Proof: pinning `fb328664...` then failed on the observed digest below, still at 253/102,
    // because re-pinning the moved project's own refusal text in pilot-policy.test.ts shifted
    // the seven `libs/domain/`, `libs/core/` and `libs/store-memory/` contexts below it; each
    // context carries its line number (2026-09-16).
    // Proof: leaving `d0b34171.../253/102` here after the standing bootstrap oracles pinned the
    // pre-move project, cwd and consumer prefixes they refuse (`core`, `libs/core`,
    // `libs/core/src`, `libs/domain/src/saved-plan`) in their `Proof:` comments failed on the
    // observed digest below at 257/106 — four more classified `test fixture or proof` contexts,
    // none unclassified (2026-09-16).
    // Proof: merging W5's `fe5c29e2.../257` into this branch's `3816d95b.../253` kept both sides'
    // contexts, so pinning either side's digest here failed on the observed digest below at 257 —
    // W5's four new `test fixture or proof` contexts report under the moved `apps/wiki/cli`
    // paths, which re-sorts them (2026-09-16).
    // Proof: leaving `b118a4b8...` here after the product-neutral marker, refs and authority
    // schema rename failed on the observed digest below, still at 257 — the only context that
    // moved is `apps/wiki/cli/src/admission/authority-store.ts`'s `libs/contracts` proof comment,
    // pushed from line 816 to 819 by the three JSDoc lines that explain the v5 bump; every other
    // context in every file this commit touched is byte-identical, checked line by line
    // (2026-09-16).
    // Proof: leaving `46db251d...` here after the wiki move's relocation selectors failed on the
    // observed digest below, still at 257 — the new obligation oracle pushed
    // pilot-policy.test.ts's four `libs/core` proof contexts from lines 962/963/990/991 to
    // 1003/1004/1031/1032. bootstrap-policy.json moved none of its five: the four
    // `sourceSelector` lines added there are cancelled exactly by the four Prettier removes when
    // the renamed `checkIds` collapsed onto one line, so its contexts sit where they did, checked
    // line by line. An intermediate pin of `9e192e79...`, taken before that reformat, failed
    // (2026-09-16).
    // Proof: leaving `e7919151...` here after the wiki product was routed failed on the observed
    // digest below, still at 257 — the four comment lines added above the RESTART_PATHS app
    // oracle pushed sync.test.ts's one `apps/mcp-01` proof context from line 314 to 318, and
    // nothing else moved; `apps/wiki/eslint.product.mjs` carries no legacy root of its own
    // (2026-09-16).
    // Proof: leaving `4c062320...` here after the legacy-authority refusal failed on the observed
    // digest below, still at 257 — the guard and its JSDoc pushed authority-store.ts's
    // `libs/contracts` proof context from line 819 to 840, the new refusal test pushed
    // claims.db.test.ts's eleven claim-path contexts down 18 lines, and the selector pin and the
    // metadata-less index mutation pushed pilot-policy.test.ts's ten contexts down 16 then 26.
    // Verified green at `84a4fd63` before these edits, so nothing else contributes; every
    // context's text and category is unchanged (2026-09-16).
    // Proof: leaving `c29abd13...` here after the CI pixels scope joined
    // pixels-workflow.test.ts failed on the observed digest below at the same 269/30 — the
    // added interface fields and scope cases carry no legacy selector of their own and only
    // shift the `apps/fe-01/test-results/` context in that file's own proof comment below
    // them (2026-09-16).
    // Proof: merging W3's `15cb68e9.../269` into this branch's `2f9b04ad.../257` failed on
    // either side's digest and, for W3's, on its count. The merged total stays at this branch's
    // 257 with every category unchanged: W3's added contexts sit in files this scan skips — its
    // own `apps/fe-01/test-results/` note in the proof chain above (this file excludes itself)
    // and `openspec/changes/affected-pr-gate/verify.md` (every `.md` is excluded). The one
    // context W3 does move is `pixels-workflow.test.ts`'s `apps/fe-01/test-results/` proof
    // comment, pushed from line 54 to 57, which is what changes the digest (2026-09-16).
    // Proof: leaving `80ba00b5...` here after the affected gate was renamed and the legacy
    // authority guard moved to `lstatSync` failed on the observed digest below, still at 257 —
    // the guard's comment and try/catch pushed authority-store.ts's `libs/contracts` context
    // from line 840 to 855, and the second legacy-store test pushed eleven of the thirteen
    // claim-path contexts in claims.db.test.ts down 33 lines, from 217-503 to 250-536, leaving
    // the two above it where they were. The renamed gate pins in toolchain-pins.test.ts, the
    // re-measured list in pixels-workflow.test.ts and ci.yml itself moved none of theirs,
    // checked line by line (2026-09-16).
    digest: 'b803d1930e75c9fca6eb470e1b9f17bad2b30f2f669efce866b6fca074cb8487',
    occurrences: 257,
    unclassified: [],
  });
});

test('every current document that trips a check carries an exemption for that check', async () => {
  const context = await documentContext();
  const unexcused: string[] = [];
  for (const check of DOCUMENT_CHECK_NAMES) {
    const exempted = await exemptedFrom(check);
    for (const path of await currentDocuments(undefined, new Set(context.candidates))) {
      if (exempted.has(path)) continue;
      if ((await DOCUMENT_CHECKS[check](path, context)).length > 0)
        unexcused.push(`${path}:${check}`);
    }
  }

  // Proof: adding `` see `libs/domain/src/x.ts` `` to docs/capacity.md failed here with
  // `docs/capacity.md:legacy-root`; dropping the docs/local-dev.md entry failed with
  // `docs/local-dev.md:legacy-root` (2026-09-15).
  expect(unexcused).toEqual([]);
});

test('every exemption names a tracked document that still needs each excuse', async () => {
  const { entries } = await readCheckExemptions();
  const context = await documentContext();

  // An entry for a path that no longer exists exempts nothing and hides that the document was
  // already repaired or deleted.
  // Proof: adding an entry for the absent docs/local-dev-gone.md failed here with that exact
  // row (2026-09-15).
  expect(entries.filter(({ path }) => !context.candidates.has(path))).toEqual([]);

  // Only the current documents are checked at all, so an entry for a tracked document outside
  // that set excuses nothing and reads as a check being held off a document it never covered.
  // Proof: adding an entry for the tracked but non-current
  // openspec/changes/repo-namespacing/design.md — which does trip `legacy-root` — failed here
  // with exactly that path; removing the entry returned the case to green (2026-09-16).
  const current = new Set(await currentDocuments(undefined, new Set(context.candidates)));
  expect(entries.filter(({ path }) => !current.has(path)).map(({ path }) => path)).toEqual([]);

  const unneeded: string[] = [];
  for (const { path, excuses } of entries) {
    if (!context.candidates.has(path)) continue;
    for (const check of excuses) {
      if ((await DOCUMENT_CHECKS[check](path, context)).length === 0)
        unneeded.push(`${path}:${check}`);
    }
  }

  // An excuse the document no longer needs is a check silently switched off for it.
  // Proof: adding `links` to the docs/local-dev.md entry, whose links all resolve, failed here
  // with `docs/local-dev.md:links` (2026-09-15).
  expect(unneeded).toEqual([]);
});

test('the current-document check exemptions have not expired', async () => {
  const exemptions = await readCheckExemptions();

  // Proof: setting expires to 2020-01-01 while 39 entries were still exempted failed here with
  // received 1577836800000 against the run's own clock (2026-09-15).
  if (exemptions.entries.length > 0) {
    expect(new Date(exemptions.expires).getTime()).toBeGreaterThan(Date.now());
  }
});
