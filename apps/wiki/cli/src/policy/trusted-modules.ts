import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hashBytes } from '../evidence/content-manifest';
import { RelocationRefusal } from './relocation-activation';

/**
 * Resolves one installed package directory, refusing anything that is not a real directory.
 * @throws {@link RelocationRefusal} `R19` naming the path.
 */
export function packageDirectory(modulesRoot: string, name: string): string {
  const path = join(modulesRoot, ...name.split('/'));
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    // Proof: rethrowing this `lstat` failure unwrapped let the absent-module negative observe
    // `ENOENT: no such file or directory, lstat '<candidate>/node_modules/typescript'` instead of
    // the named refusal, so the operator was sent to Node's message and not to the missing install.
    throw new RelocationRefusal('R19', `trusted node module is absent or a symlink: ${path}`, {
      cause,
    });
  }
  // Proof: forcing this refusal false let the archive copy symlinked packages out of the
  // candidate's installed tree; the R19 negative expected exit 1 and received 0 with a complete
  // archive.
  if (!stats.isDirectory()) {
    throw new RelocationRefusal('R19', `trusted node module is absent or a symlink: ${path}`);
  }
  return path;
}

/**
 * The transitive `dependencies` closure of `typescript` as the tree installed it, sorted.
 *
 * This closure is a role a relocation activation and a toolkit release both derive from an
 * installed tree, and both must derive it identically: a toolkit's `trusted-node-modules` and a
 * relocation archive's are the same role, and a consumer's launcher cannot tell them apart.
 * {@link hashTrustedModules} is what pins the bytes once they are copied.
 * @throws {@link RelocationRefusal} `R19` for a member that is absent or not a directory.
 */
export function trustedModuleNames(modulesRoot: string): string[] {
  const names = new Set<string>();
  const pending = ['typescript'];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || names.has(name)) continue;
    names.add(name);
    // The installed manifest is the tree's own lockfile-pinned bytes; only its dependency names
    // are read, and an absent or malformed file throws rather than widening the closure.
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory(modulesRoot, name), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push(dependency);
  }
  return [...names].sort();
}

/** Copies the named packages under `destination`, preserving symlinks rather than following them. */
export function copyTrustedModules(
  destination: string,
  modulesRoot: string,
  names: readonly string[],
): void {
  mkdirSync(destination, { recursive: true });
  for (const name of names) {
    const target = join(destination, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(packageDirectory(modulesRoot, name), target, { dereference: false, recursive: true });
  }
}

/**
 * One digest over a copied closure: every regular file below `root`, as sorted
 * `<relative path>:<sha256>` lines. A toolkit records it so a consumer can prove the 24 MB of
 * vendored TypeScript it is about to load is the reviewed copy, which `SHA256SUMS` cannot do
 * file-by-file without dwarfing the descriptor it lives in.
 * @throws Error when `root` is not a readable directory.
 */
export function hashTrustedModules(root: string): string {
  const lines: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, relative);
      // A symlink inside the closure is not a file this digest can pin; `packageDirectory` already
      // refuses a symlinked package, and a symlinked file below one would resolve outside the copy.
      else if (entry.isFile()) lines.push(`${relative}:${hashBytes(readFileSync(path))}`);
      else throw new Error(`trusted node modules carry a non-regular entry: ${relative}`);
    }
  };
  walk(root, '');
  return hashBytes(new TextEncoder().encode(`${lines.sort().join('\n')}\n`));
}

export function writeBytes(path: string, bytes: Uint8Array | string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/**
 * Bundles one entry into a standalone ESM module with the running Bun. The caller pins that Bun
 * first (`assertPinnedRuntime` in `relocation-activation.ts`, `assertReleaseRuntime` in
 * `release.ts`), because the bundle's digest is what the activation binds.
 * @throws Error naming the entry when the bundle cannot be produced.
 */
export async function buildValidatorBundle(
  entryPath: string,
  entryLabel = entryPath,
): Promise<Uint8Array> {
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({ entrypoints: [entryPath], target: 'bun', format: 'esm' });
  } catch (cause) {
    // Proof: letting Bun's own `Bundle failed` escape named neither the entry nor the candidate;
    // the unbuildable-entry negative expected this message and received `Bundle failed`.
    // `entryLabel` keeps that message the caller's own repository-relative entry rather than a
    // scratch-directory absolute path the operator never wrote.
    throw new Error(`cannot rebuild the candidate validator from ${entryLabel}`, { cause });
  }
  // A build that reports failure without throwing is not reachable from the fixture entries, so
  // this guard carries no observed negative; it keeps an unsuccessful build out of the archive.
  if (!built.success || built.outputs.length !== 1) {
    throw new Error(
      `cannot rebuild the candidate validator from ${entryLabel}: ${built.logs.map(String).join('; ')}`,
    );
  }
  return new Uint8Array(await built.outputs[0].arrayBuffer());
}
