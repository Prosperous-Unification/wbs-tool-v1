import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_GROUPS = ['apps', 'libs', 'tools'];
// Proof: omitting `.git` failed the recursive fixture with the unexpected
// project `libs/outer/.git/hidden` (2026-09-14).
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
  // `readProjects unexpectedly succeeded` (2026-09-14).
  throw new Error(`directory is symlinked: ${relativePath(path, root)}`);
}

/**
 * Reject a workspace project-group link before readdir can follow it.
 *
 * @param {string} path
 * @param {string} root
 */
async function rejectSymlinkedProjectGroup(path, root) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (failure) {
    throw new Error(`cannot read directory ${relativePath(path, root)}`, { cause: failure });
  }
  // Proof: omitting this refusal made the top-level group fixture report
  // `readProjects unexpectedly succeeded` (2026-09-14).
  if (entry.isSymbolicLink()) {
    throw new Error(`directory is symlinked: ${relativePath(path, root)}`);
  }
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
  for (const group of PROJECT_GROUPS) {
    const path = join(root, group);
    await rejectSymlinkedProjectGroup(path, root);
    await scanDirectory(path, root, projects);
  }

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
 * graph. Shared product code may depend only on other shared product code. One
 * trailing `scope:infra` rule holds product-less infrastructure to infra and
 * the shared product, because such a project carries no `product:` tag for the
 * per-product rules above to match.
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

  const perProduct = [...products].sort().map((product) => ({
    sourceTag: `product:${product}`,
    // Proof: removing only the generated product:probe rule made the fixture's
    // actual uncached Nx lint accept its forbidden @wbs/core production import
    // with exit 0. Adding product:wbs to shared likewise made the shared-source
    // fixture's forbidden import pass with exit 0 (2026-09-14).
    onlyDependOnLibsWithTags:
      product === 'shared' ? ['product:shared'] : [`product:${product}`, 'product:shared'],
  }));
  return [
    ...perProduct,
    // Proof: without this rule the fixture's probe tool imported `@wbs/core` and its
    // uncached Nx lint exited 0, failing `refuses a product import from a product-less
    // tool and admits shared` on `Expected: 1 · Received: 0` (2026-09-15). Tools carry no
    // product tag, so no per-product rule above ever applies to them.
    { sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:infra', 'product:shared'] },
  ];
}

/** @param {NamespaceProject} project @param {string} axis */
function filterTags(project, axis) {
  return project.tags.filter((tag) => tag.startsWith(axis));
}

/**
 * Find every disagreement between discovered projects and the final product
 * namespace. Callers decide when to enforce the violations so the pre-move
 * fixture can prove the final policy without rejecting the current layout.
 *
 * @param {readonly NamespaceProject[]} projects
 * @returns {readonly string[]}
 */
export function findNamespaceLayoutViolations(projects) {
  /** @type {string[]} */
  const violations = [];
  for (const project of projects) {
    const scopes = filterTags(project, 'scope:');
    const rings = filterTags(project, 'ring:');
    const runtimes = filterTags(project, 'runtime:');
    for (const [axis, tags] of [
      ['scope:', scopes],
      ['ring:', rings],
      ['runtime:', runtimes],
    ]) {
      // Proof: disabling this common cardinality guard made the owning Nx test
      // target report six named failures: absent and duplicate scope, ring and
      // runtime tags all returned no violation (2026-09-14).
      if (tags.length !== 1) {
        violations.push(
          `${project.root}: expected exactly one ${axis} tag, found ${String(tags.length)}`,
        );
      }
    }

    const products = filterTags(project, 'product:');
    if (project.root.startsWith('tools/')) {
      // Proof: disabling this check made the owning Nx target omit the
      // scope:shared tool violation while retaining its ring and product faults
      // (2026-09-14).
      if (scopes.length === 1 && scopes[0] !== 'scope:infra') {
        violations.push(`${project.root}: tools require scope:infra, found ${scopes[0]}`);
      }
      // Proof: disabling this check made the owning Nx target omit the
      // ring:domain tool violation while retaining its scope and product faults
      // (2026-09-14).
      if (rings.length === 1 && rings[0] !== 'ring:adapter') {
        violations.push(`${project.root}: tools require ring:adapter, found ${rings[0]}`);
      }
      // Proof: disabling this check made the owning Nx target omit the
      // product:wbs violation from its otherwise-invalid tool fixture
      // (2026-09-14).
      if (products.length > 0) {
        violations.push(
          `${project.root}: tools must not carry a product tag, found ${products.join(', ')}`,
        );
      }
      continue;
    }

    // Proof: disabling this root-group guard made the owning Nx target replace
    // the named outside-root refusal with a misleading library-shape fault
    // (2026-09-14).
    if (!project.root.startsWith('apps/') && !project.root.startsWith('libs/')) {
      violations.push(`${project.root}: project root must begin with apps/, libs/ or tools/`);
      continue;
    }
    // Proof: disabling this product cardinality guard made the owning Nx target
    // report both absent and duplicate product fixtures returning no violation
    // (2026-09-14).
    if (products.length !== 1) {
      violations.push(
        `${project.root}: expected exactly one product: tag, found ${String(products.length)}`,
      );
    }

    const segments = project.root.split('/');
    if (project.root.startsWith('apps/')) {
      // Proof: disabling this shape guard made the owning Nx target replace the
      // named malformed-app refusal with misleading derived product/name faults
      // (2026-09-14).
      if (segments.length !== 3) {
        violations.push(`${project.root}: applications require apps/<product>/<project>`);
        continue;
      }
      // Proof: disabling this check made the owning Nx target omit the app's
      // ring:application refusal while retaining its malformed-shape refusal
      // (2026-09-14).
      if (rings.length === 1 && rings[0] !== 'ring:adapter') {
        violations.push(`${project.root}: applications require ring:adapter, found ${rings[0]}`);
      }
      // Proof: disabling this check made the owning Nx target omit the app's
      // directory/product disagreement while retaining the library refusal
      // (2026-09-14).
      if (products.length === 1 && products[0] !== `product:${segments[1]}`) {
        violations.push(
          `${project.root}: directory product ${segments[1]} disagrees with ${products[0]}`,
        );
      }
      const expectedName = `${segments[1]}-${segments[2]}`;
      // Proof: disabling this app-name check made the owning Nx target omit the
      // unqualified be-01 refusal while retaining the library refusal
      // (2026-09-14).
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
    // Proof: disabling this shape guard made the owning Nx target replace the
    // named unknown-library-ring refusal with a derived `requires undefined`
    // fault (2026-09-14).
    if (segments.length !== 4 || expectedRing === undefined) {
      violations.push(
        `${project.root}: libraries require libs/<product>/<domain|application|adapters>/<project>`,
      );
      continue;
    }
    // Proof: disabling this check made the owning Nx target omit the library's
    // directory/product disagreement while retaining the app refusal
    // (2026-09-14).
    if (products.length === 1 && products[0] !== `product:${segments[1]}`) {
      violations.push(
        `${project.root}: directory product ${segments[1]} disagrees with ${products[0]}`,
      );
    }
    // Proof: disabling this correlation made the owning Nx target omit the
    // adapters-to-ring:adapter refusal for a ring:application library
    // (2026-09-14).
    if (rings.length === 1 && rings[0] !== expectedRing) {
      violations.push(
        `${project.root}: directory ${segments[2]} requires ${expectedRing}, found ${rings[0]}`,
      );
    }
    const expectedName = `${segments[1]}-${segments[3]}`;
    // Proof: disabling this library-name check made the owning Nx target omit
    // the unqualified core refusal while retaining the app refusal
    // (2026-09-14).
    if (project.name !== expectedName) {
      violations.push(
        `${project.root}: project name must be ${expectedName}, found ${project.name}`,
      );
    }
  }
  return violations;
}
