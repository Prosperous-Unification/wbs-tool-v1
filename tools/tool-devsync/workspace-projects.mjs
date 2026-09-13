import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_GROUPS = ['apps', 'libs', 'tools'];
// Proof: omitting `.git` failed the generated-tree fixture with the unexpected
// project `libs/outer/.git/hidden` (2026-09-13).
const EXCLUDED_DIRECTORIES = new Set(['.git', '.nx', 'coverage', 'dist', 'node_modules']);

/**
 * @typedef {Readonly<{
 *   options?: Readonly<{ command?: string; commands?: readonly string[] }>;
 *   inputs?: readonly (string | Readonly<Record<string, unknown>>)[];
 * } & Record<string, unknown>>} ProjectTarget
 */

/** @typedef {Readonly<Record<string, ProjectTarget | undefined>>} ProjectTargets */

/**
 * @typedef {Readonly<{
 *   root: string;
 *   name: string;
 *   tags: readonly string[];
 * }>} NamespaceProject
 */

/**
 * @typedef {Readonly<{
 *   root: string;
 *   name: string;
 *   tags: readonly string[];
 *   targets: ProjectTargets;
 * }>} WorkspaceProject
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} failure */
function errorCode(failure) {
  if (!isRecord(failure)) return undefined;
  return typeof failure['code'] === 'string' ? failure['code'] : undefined;
}

/** @param {string | URL} workspace */
function workspacePath(workspace) {
  return typeof workspace === 'string' ? resolve(workspace) : fileURLToPath(workspace);
}

/** @param {string} path @param {string} root */
function relativePath(path, root) {
  return relative(root, path).split(sep).join('/');
}

/**
 * Validate the manifest facts every workspace gate consumes.
 *
 * @param {unknown} value
 * @param {string} path
 * @returns {{ name: string; tags: string[]; targets: ProjectTargets }}
 */
function parseManifest(value, path) {
  if (!isRecord(value)) throw new Error(`${path} is not an object`);
  const name = value['name'];
  const manifestTags = value['tags'];
  const manifestTargets = value['targets'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${path} has invalid name`);
  }
  if (!Array.isArray(manifestTags) || !manifestTags.every((tag) => typeof tag === 'string')) {
    throw new Error(`${path} has invalid tags`);
  }
  if (!isRecord(manifestTargets)) throw new Error(`${path} has invalid targets`);
  // Proof: removing this guard failed the no-target case on `readProjects
  // unexpectedly succeeded` (2026-09-09).
  if (Object.keys(manifestTargets).length === 0) {
    throw new Error(`${path} must declare at least one target`);
  }
  /** @type {Record<string, ProjectTarget | undefined>} */
  const targets = {};
  for (const [target, definition] of Object.entries(manifestTargets)) {
    if (target.length === 0 || !isRecord(definition)) {
      throw new Error(`${path} has invalid target ${target || '<empty>'}`);
    }
    // Boundary cast: the manifest check above proves every target is an object;
    // consumers validate any target-specific options they inspect.
    targets[target] = /** @type {ProjectTarget} */ (definition);
  }
  // Boundary cast: every element was checked as a string above.
  const tags = /** @type {string[]} */ (manifestTags);
  // Proof: removing this loop failed both ring cases on `readProjects unexpectedly
  // succeeded` for zero and two ring tags (2026-09-09).
  for (const axis of ['scope:', 'ring:', 'runtime:']) {
    const count = tags.filter((tag) => tag.startsWith(axis)).length;
    if (count !== 1) throw new Error(`${path} must carry exactly one ${axis} tag; found ${count}`);
  }
  return {
    name,
    tags: [...tags],
    targets,
  };
}

/**
 * Read a manifest when the directory declares one. A missing manifest models
 * an ordinary source directory; every other read failure is unknown state.
 *
 * @param {string} directory
 * @param {string} root
 * @returns {Promise<WorkspaceProject | undefined>}
 */
async function readProject(directory, root) {
  const manifest = join(directory, 'project.json');
  const path = relativePath(manifest, root);
  let text;
  try {
    text = await readFile(manifest, 'utf8');
  } catch (failure) {
    if (errorCode(failure) === 'ENOENT') return undefined;
    // Proof: treating this failure as absent failed the unreadable-manifest
    // case on `readProjects unexpectedly succeeded` (2026-09-09).
    throw new Error(`cannot read ${path}`, { cause: failure });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (failure) {
    throw new Error(`cannot parse ${path}`, { cause: failure });
  }
  const manifestValue = parseManifest(value, path);
  return { root: relativePath(directory, root), ...manifestValue };
}

/**
 * A directory symlink is never traversed because its physical ownership is
 * ambiguous even when it does not currently contain a project manifest.
 *
 * @param {string} path
 * @param {string} root
 */
async function rejectSymlinkedDirectory(path, root) {
  let target;
  try {
    target = await stat(path);
  } catch (failure) {
    throw new Error(`cannot inspect symlink ${relativePath(path, root)}`, { cause: failure });
  }
  if (!target.isDirectory()) return;
  // Proof: accepting a directory symlink whose target had no manifest failed
  // `rejects every symlinked directory even when it has no manifest` on
  // `readProjects unexpectedly succeeded` (2026-09-13).
  throw new Error(`directory is symlinked: ${relativePath(path, root)}`);
}

/**
 * @param {string} directory
 * @param {string} root
 * @param {WorkspaceProject[]} projects
 */
async function scanDirectory(directory, root, projects) {
  const path = relativePath(directory, root);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (failure) {
    // Proof: treating this failure as an empty directory failed the unreadable-
    // directory case on `readProjects unexpectedly succeeded` (2026-09-09).
    throw new Error(`cannot read directory ${path}`, { cause: failure });
  }

  const project = await readProject(directory, root);
  if (project !== undefined) projects.push(project);

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // Proof: skipping this rejection failed the symlink case on
      // `readProjects unexpectedly succeeded` (2026-09-09).
      await rejectSymlinkedDirectory(child, root);
      continue;
    }
    // Proof: replacing this recursion with `continue` failed the nested-project
    // test with `Expected: outer, protocol · Received: []` (2026-09-09).
    if (entry.isDirectory()) await scanDirectory(child, root, projects);
  }
}

/**
 * Recursively read every Nx project manifest below the workspace project
 * groups, including a project nested below another project.
 *
 * @param {string | URL} workspace
 * @returns {Promise<readonly WorkspaceProject[]>}
 */
export async function readProjects(workspace) {
  const root = workspacePath(workspace);
  /** @type {WorkspaceProject[]} */
  const projects = [];
  for (const group of PROJECT_GROUPS) await scanDirectory(join(root, group), root, projects);

  projects.sort((left, right) => left.root.localeCompare(right.root));
  const rootsByName = new Map();
  for (const project of projects) {
    const earlier = rootsByName.get(project.name);
    // Proof: removing this branch failed the duplicate-name case on
    // `readProjects unexpectedly succeeded` (2026-09-09).
    if (earlier !== undefined) {
      throw new Error(`duplicate project name ${project.name}: ${earlier} and ${project.root}`);
    }
    rootsByName.set(project.name, project.root);
  }
  return projects;
}

/**
 * Build Nx dependency constraints for every product present in the project
 * graph. Product infrastructure stays untagged and therefore contributes no
 * rule; shared product code may depend only on other shared product code.
 *
 * @param {readonly WorkspaceProject[]} projects
 * @returns {readonly Readonly<{
 *   sourceTag: string;
 *   onlyDependOnLibsWithTags: readonly string[];
 * }>[]}
 */
export function productConstraints(projects) {
  /** @type {Set<string>} */
  const products = new Set();
  for (const project of projects) {
    for (const tag of project.tags) {
      if (tag.startsWith('product:')) products.add(tag.slice('product:'.length));
    }
  }

  return [...products].sort().map((product) => ({
    sourceTag: `product:${product}`,
    // Proof: dropping only `product:probe` made the actual fixture Nx lint
    // accept its `@wbs/core` production import; the negative then received
    // exit 0. Allowing WBS here for shared did the same in the shared-source
    // case. Both were watched through Nx on 2026-09-13.
    onlyDependOnLibsWithTags:
      product === 'shared' ? ['product:shared'] : [`product:${product}`, 'product:shared'],
  }));
}

/** @param {NamespaceProject} project @param {string} axis */
function tagsOn(project, axis) {
  return project.tags.filter((tag) => tag.startsWith(axis));
}

/**
 * Find every disagreement between a discovered project and the final product
 * namespace. The caller decides when to enforce the returned violations so a
 * pre-move fixture can prove the final rules before the coordinated rename.
 *
 * @param {readonly NamespaceProject[]} projects
 * @returns {readonly string[]}
 */
export function findNamespaceLayoutViolations(projects) {
  /** @type {string[]} */
  const violations = [];
  for (const project of projects) {
    const scopes = tagsOn(project, 'scope:');
    const rings = tagsOn(project, 'ring:');
    const runtimes = tagsOn(project, 'runtime:');
    for (const [axis, tags] of [
      ['scope:', scopes],
      ['ring:', rings],
      ['runtime:', runtimes],
    ]) {
      // Proof: replacing this guard with `false` made the Nx test target fail
      // first on the absent scope fixture, which returned no violation (2026-09-13).
      if (tags.length !== 1) {
        violations.push(
          `${project.root}: expected exactly one ${axis} tag, found ${String(tags.length)}`,
        );
      }
    }

    const products = tagsOn(project, 'product:');
    if (project.root.startsWith('tools/')) {
      // Proof: disabling these three checks made the Nx test target return no
      // violations for the shared/domain/product:wbs tool fixture (2026-09-13).
      if (scopes.length === 1 && scopes[0] !== 'scope:infra') {
        violations.push(`${project.root}: tools require scope:infra, found ${scopes[0]}`);
      }
      if (rings.length === 1 && rings[0] !== 'ring:adapter') {
        violations.push(`${project.root}: tools require ring:adapter, found ${rings[0]}`);
      }
      if (products.length > 0) {
        violations.push(
          `${project.root}: tools must not carry a product tag, found ${products.join(', ')}`,
        );
      }
      continue;
    }

    // Proof: disabling this check made packages/probe fall through to a library-
    // shape error, failing the Nx target's exact root-boundary oracle (2026-09-13).
    if (!project.root.startsWith('apps/') && !project.root.startsWith('libs/')) {
      violations.push(`${project.root}: project root must begin with apps/, libs/ or tools/`);
      continue;
    }
    // Proof: replacing this guard with `false` made the Nx test target return no
    // violation for an absent product tag (2026-09-13).
    if (products.length !== 1) {
      violations.push(
        `${project.root}: expected exactly one product: tag, found ${String(products.length)}`,
      );
    }

    const segments = project.root.split('/');
    if (project.root.startsWith('apps/')) {
      // Proof: disabling the app shape check replaced its expected refusal with
      // nonsensical product/name errors in the Nx test target (2026-09-13).
      if (segments.length !== 3) {
        violations.push(`${project.root}: applications require apps/<product>/<project>`);
        continue;
      }
      // Proof: disabling these app correlation checks made the Nx target omit
      // its ring, product and qualified-name violations (2026-09-13).
      if (rings.length === 1 && rings[0] !== 'ring:adapter') {
        violations.push(`${project.root}: applications require ring:adapter, found ${rings[0]}`);
      }
      if (products.length === 1 && products[0] !== `product:${segments[1]}`) {
        violations.push(
          `${project.root}: directory product ${segments[1]} disagrees with ${products[0]}`,
        );
      }
      const expectedName = `${segments[1]}-${segments[2]}`;
      if (project.name !== expectedName) {
        violations.push(
          `${project.root}: project name must be ${expectedName}, found ${project.name}`,
        );
      }
      continue;
    }

    /** @type {Readonly<Record<string, string>>} */
    const ringByDirectory = {
      domain: 'ring:domain',
      application: 'ring:application',
      adapters: 'ring:adapter',
    };
    const expectedRing = ringByDirectory[segments[2]];
    // Proof: disabling both shape guards replaced their two named refusals with
    // derived undefined product/ring/name errors in the Nx target (2026-09-13).
    if (segments.length !== 4 || expectedRing === undefined) {
      violations.push(
        `${project.root}: libraries require libs/<product>/<domain|application|adapters>/<project>`,
      );
      continue;
    }
    // Proof: disabling these three library correlation checks made the Nx target
    // omit the product, adapters-ring and qualified-name violations (2026-09-13).
    if (products.length === 1 && products[0] !== `product:${segments[1]}`) {
      violations.push(
        `${project.root}: directory product ${segments[1]} disagrees with ${products[0]}`,
      );
    }
    if (rings.length === 1 && rings[0] !== expectedRing) {
      violations.push(
        `${project.root}: directory ${segments[2]} requires ${expectedRing}, found ${rings[0]}`,
      );
    }
    const expectedName = `${segments[1]}-${segments[3]}`;
    if (project.name !== expectedName) {
      violations.push(
        `${project.root}: project name must be ${expectedName}, found ${project.name}`,
      );
    }
  }
  return violations;
}
