import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_GROUPS = ['apps', 'libs', 'tools'];
const EXCLUDED_DIRECTORIES = new Set(['.nx', 'coverage', 'dist', 'node_modules']);

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
 * A symlink is never traversed. If it points at a directory containing a
 * manifest, it is a project directory whose physical ownership is ambiguous.
 *
 * @param {string} path
 * @param {string} root
 */
async function rejectSymlinkedProject(path, root) {
  let target;
  try {
    target = await stat(path);
  } catch (failure) {
    throw new Error(`cannot inspect symlink ${relativePath(path, root)}`, { cause: failure });
  }
  if (!target.isDirectory()) return;

  try {
    await lstat(join(path, 'project.json'));
  } catch (failure) {
    if (errorCode(failure) === 'ENOENT') return;
    throw new Error(`cannot inspect ${relativePath(join(path, 'project.json'), root)}`, {
      cause: failure,
    });
  }
  throw new Error(`project directory is symlinked: ${relativePath(path, root)}`);
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
      await rejectSymlinkedProject(child, root);
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
