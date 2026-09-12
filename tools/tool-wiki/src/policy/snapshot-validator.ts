import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

interface ArtifactReference {
  path: string;
  sha256: string;
}

interface ResolvedArtifact extends ArtifactReference {
  referencePath: string;
}

interface CapturedArtifact extends ResolvedArtifact {
  bytes: Uint8Array;
}

interface ResolvedImport {
  path: string;
  isExternal: boolean;
}

interface ValidatorClosure {
  imports: ReadonlyMap<string, ResolvedImport>;
  paths: string[];
}

function fail(message: string): never {
  throw new Error(`tool-wiki snapshot: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(root: string, path: string): boolean {
  const offset = relative(root, path);
  const isParent = offset === '..' || offset.startsWith(`..${sep}`);
  return offset === '' || (!isParent && !isAbsolute(offset));
}

function artifactReferences(bindingPath: string): ResolvedArtifact[] {
  const input = JSON.parse(readFileSync(bindingPath, 'utf8')) as unknown;
  if (typeof input !== 'object' || input === null) fail('binding must be an object');
  // The JSON object checks are the untyped input boundary for this standalone bootstrap tool.
  const inputRecord = input as Record<string, unknown>;
  const validator = inputRecord['validator'];
  if (typeof validator !== 'object' || validator === null) fail('binding validator is absent');
  // The validator object check makes its fields unknown rather than trusted values.
  const validatorRecord = validator as Record<string, unknown>;
  const artifacts = validatorRecord['artifacts'];
  if (!Array.isArray(artifacts) || artifacts.length === 0) fail('binding artifacts are absent');
  return artifacts.map((artifact, index) => {
    if (typeof artifact !== 'object' || artifact === null)
      fail(`artifact ${String(index)} is invalid`);
    // Each array member is narrowed before its individual fields are validated below.
    const artifactRecord = artifact as Record<string, unknown>;
    const path = artifactRecord['path'];
    const digest = artifactRecord['sha256'];
    if (typeof path !== 'string' || path.length === 0)
      fail(`artifact ${String(index)} path is invalid`);
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
      fail(`artifact ${String(index)} digest is invalid`);
    return { referencePath: path, path: resolve(dirname(bindingPath), path), sha256: digest };
  });
}

function captureArtifacts(
  references: readonly ResolvedArtifact[],
  candidateRoot: string,
): CapturedArtifact[] {
  const seen = new Set<string>();
  return references.map((reference) => {
    const status = lstatSync(reference.path);
    if (status.isSymbolicLink() || !status.isFile())
      fail(`artifact is not a regular file: ${reference.path}`);
    const path = realpathSync(reference.path);
    // Proof: gate-entrypoints.test.ts bound candidate/..trust/dependency.ts; the prefix-only
    // comparison let it execute and failed on `Expected: false / Received: true`.
    if (isWithin(candidateRoot, path)) fail(`artifact resolves inside candidate: ${path}`);
    if (seen.has(path)) fail(`duplicate artifact path: ${path}`);
    seen.add(path);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== reference.sha256) fail(`artifact digest mismatch: ${path}`);
    return { referencePath: reference.referencePath, path, sha256: reference.sha256, bytes };
  });
}

function sourceLoader(path: string): 'js' | 'ts' {
  return path.endsWith('.ts') ? 'ts' : 'js';
}

function importIdentity(importer: string, specifier: string): string {
  return JSON.stringify([importer, specifier]);
}

function resolveClosure(
  entryPath: string,
  artifacts: readonly CapturedArtifact[],
): ValidatorClosure {
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const pending = [entryPath];
  const visited = new Set<string>();
  const reachable = new Set<string>(pending);
  const imports = new Map<string, ResolvedImport>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const artifact = artifactsByPath.get(path);
    if (artifact === undefined) continue;
    for (const { path: specifier } of new Bun.Transpiler({
      loader: sourceLoader(path),
    }).scanImports(artifact.bytes)) {
      let resolvedImport: string;
      try {
        const resolvedDependency = Bun.resolveSync(specifier, dirname(path));
        if (resolvedDependency.startsWith('node:') || resolvedDependency.startsWith('bun:')) {
          imports.set(importIdentity(path, specifier), {
            path: resolvedDependency,
            isExternal: true,
          });
          continue;
        }
        resolvedImport = realpathSync(resolvedDependency);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        fail(`cannot resolve validator dependency ${specifier} from ${path}: ${detail}`);
      }
      imports.set(importIdentity(path, specifier), { path: resolvedImport, isExternal: false });
      if (!reachable.has(resolvedImport)) {
        reachable.add(resolvedImport);
        pending.push(resolvedImport);
      }
    }
  }
  return { imports, paths: [...reachable].sort() };
}

async function buildValidator(
  cliPath: string,
  artifacts: readonly CapturedArtifact[],
  imports: ReadonlyMap<string, ResolvedImport>,
): Promise<Bun.BuildOutput> {
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const entrySpecifier = 'tool-wiki-captured-validator-entry';
  const namespace = 'tool-wiki-captured-validator';
  return Bun.build({
    entrypoints: [entrySpecifier],
    target: 'bun',
    format: 'esm',
    plugins: [
      {
        name: namespace,
        setup(builder) {
          builder.onResolve({ filter: /[\s\S]*/ }, ({ path: specifier, importer, kind }) => {
            if (kind === 'entry-point-build' && importer === '' && specifier === entrySpecifier) {
              return { path: cliPath, namespace };
            }
            const resolvedImport = imports.get(importIdentity(importer, specifier));
            if (resolvedImport === undefined) {
              fail(
                `bundle requested dependency outside captured closure: ${specifier} from ${importer}`,
              );
            }
            return resolvedImport.isExternal
              ? { path: resolvedImport.path, external: true }
              : { path: resolvedImport.path, namespace };
          });
          builder.onLoad({ filter: /[\s\S]*/, namespace }, ({ path }) => {
            const artifact = artifactsByPath.get(path);
            if (artifact === undefined) fail(`bundle requested uncaptured artifact: ${path}`);
            // Proof: gate-entrypoints.test.ts swaps dependency bytes only while Bun.build runs;
            // the original-path build executed them (`Expected: false / Received: true`).
            return { contents: artifact.bytes, loader: sourceLoader(path) };
          });
        },
      },
    ],
    define: {
      __TOOL_WIKI_BUNDLED_ARTIFACTS__: JSON.stringify(
        JSON.stringify(artifacts.map(({ referencePath: path, sha256 }) => ({ path, sha256 }))),
      ),
    },
  });
}

const [bindingInput, cliInput, candidateInput, outputPath] = process.argv.slice(2);
if (process.argv.length !== 6) fail('usage: snapshot <binding> <cli> <candidate> <output>');
const bindingPath = realpathSync(bindingInput);
const cliPath = realpathSync(cliInput);
const candidateRoot = realpathSync(candidateInput);
const artifacts = captureArtifacts(artifactReferences(bindingPath), candidateRoot);
if (!artifacts.some(({ path }) => path === cliPath))
  fail('validator CLI is absent from binding artifacts');
const closure = resolveClosure(cliPath, artifacts);
const reviewedPaths = artifacts.map(({ path }) => path).sort();
if (JSON.stringify(closure.paths) !== JSON.stringify(reviewedPaths)) {
  // Proof: gate-entrypoints.test.ts omits an imported validator dependency from the binding and
  // observes this production snapshot command refuse before the dependency can execute.
  fail('binding artifacts do not match the complete validator closure');
}

const built = await buildValidator(cliPath, artifacts, closure.imports);
if (!built.success || built.outputs.length !== 1) fail('validator bundle failed');
await Bun.write(outputPath, built.outputs[0]);
