import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

interface ArtifactReference {
  path: string;
  sha256: string;
}

interface ResolvedArtifact extends ArtifactReference {
  referencePath: string;
}

function fail(message: string): never {
  throw new Error(`tool-wiki snapshot: ${message}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
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

function validateArtifacts(
  references: readonly ResolvedArtifact[],
  candidateRoot: string,
): ResolvedArtifact[] {
  const seen = new Set<string>();
  return references.map((reference) => {
    const status = lstatSync(reference.path);
    if (status.isSymbolicLink() || !status.isFile())
      fail(`artifact is not a regular file: ${reference.path}`);
    const path = realpathSync(reference.path);
    if (isWithin(candidateRoot, path)) fail(`artifact resolves inside candidate: ${path}`);
    if (seen.has(path)) fail(`duplicate artifact path: ${path}`);
    seen.add(path);
    if (sha256(readFileSync(path)) !== reference.sha256) fail(`artifact digest mismatch: ${path}`);
    return { referencePath: reference.referencePath, path, sha256: reference.sha256 };
  });
}

function resolveClosure(entryPath: string): string[] {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile())
      fail(`validator dependency is not a regular file: ${path}`);
    visited.add(path);
    const source = readFileSync(path, 'utf8');
    const loader = path.endsWith('.ts') ? 'ts' : 'js';
    for (const { path: specifier } of new Bun.Transpiler({ loader }).scanImports(source)) {
      if (specifier.startsWith('node:') || specifier.startsWith('bun:')) continue;
      let dependency: string;
      try {
        const resolvedDependency = Bun.resolveSync(specifier, dirname(path));
        if (resolvedDependency.startsWith('node:') || resolvedDependency.startsWith('bun:'))
          continue;
        dependency = realpathSync(resolvedDependency);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        fail(`cannot resolve validator dependency ${specifier} from ${path}: ${detail}`);
      }
      pending.push(dependency);
    }
  }
  return [...visited].sort();
}

const [bindingInput, cliInput, candidateInput, outputPath] = process.argv.slice(2);
if (process.argv.length !== 6) fail('usage: snapshot <binding> <cli> <candidate> <output>');
const bindingPath = realpathSync(bindingInput);
const cliPath = realpathSync(cliInput);
const candidateRoot = realpathSync(candidateInput);
const artifacts = validateArtifacts(artifactReferences(bindingPath), candidateRoot);
if (!artifacts.some(({ path }) => path === cliPath))
  fail('validator CLI is absent from binding artifacts');
const closure = resolveClosure(cliPath);
const reviewedPaths = artifacts.map(({ path }) => path).sort();
if (JSON.stringify(closure) !== JSON.stringify(reviewedPaths)) {
  // Proof: gate-entrypoints.test.ts omits an imported validator dependency from the binding and
  // observes this production snapshot command refuse before the dependency can execute.
  fail('binding artifacts do not match the complete validator closure');
}

const built = await Bun.build({
  entrypoints: [cliPath],
  target: 'bun',
  format: 'esm',
  define: {
    __TOOL_WIKI_BUNDLED_ARTIFACTS__: JSON.stringify(
      JSON.stringify(artifacts.map(({ referencePath: path, sha256 }) => ({ path, sha256 }))),
    ),
  },
});
if (!built.success || built.outputs.length !== 1) fail('validator bundle failed');

// Re-read every reviewed input after bundling: a mutation during the build invalidates the
// snapshot rather than letting the bundle combine bytes from two identities.
// Proof: gate-entrypoints.test.ts swaps the original after this command returns; the already
// written bundle retains the reviewed behavior and never executes the candidate replacement.
validateArtifacts(artifacts, candidateRoot);
await Bun.write(outputPath, built.outputs[0]);
