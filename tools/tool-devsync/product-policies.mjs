import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const POLICY_GROUPS = ['apps', 'libs'];
const POLICY_FILE = 'eslint.product.mjs';

/**
 * One flat-config object as ESLint consumes it. The shape is ESLint's, not this module's:
 * discovery checks that a policy returns an array and hands the objects on unread.
 *
 * @typedef {Readonly<Record<string, unknown>>} FlatConfigObject
 */

/**
 * The boundary constants the root config owns and a product policy composes with, passed as
 * an argument because the root config imports a policy dynamically — a static import back
 * would close the cycle.
 *
 * @typedef {Readonly<Record<string, unknown>>} SharedConstraints
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} failure @returns {string | undefined} */
function errorCode(failure) {
  if (!isRecord(failure)) return undefined;
  return typeof failure['code'] === 'string' ? failure['code'] : undefined;
}

/** @param {string | URL} workspace @returns {string} */
function workspacePath(workspace) {
  return typeof workspace === 'string' ? resolve(workspace) : fileURLToPath(workspace);
}

/**
 * Whether a product contributes a policy at all, decided on the file rather than on what
 * importing it raises.
 *
 * Absence is the normal case — most product directories contribute nothing — and it is the
 * only failure discovery passes over. It is decided here, before `import()`, because Bun and
 * Node raise `ERR_MODULE_NOT_FOUND` both for a policy that is not there and for a policy that
 * is there and imports a package that is not: a policy file that names six plugin packages
 * cannot be allowed to read as absent because one of them is missing.
 *
 * @param {string} policyPath Absolute path to a candidate `eslint.product.mjs`.
 * @returns {Promise<boolean>} True when the file exists and must therefore load.
 * @throws When the path cannot be resolved for any reason other than not existing.
 */
async function isPolicyPresent(policyPath) {
  try {
    await stat(policyPath);
    return true;
  } catch (failure) {
    if (errorCode(failure) === 'ENOENT') return false;
    throw new Error(`cannot read product lint policy ${policyPath}`, { cause: failure });
  }
}

/**
 * Every flat-config object the products under `apps/` and `libs/` contribute, in group then
 * alphabetical order.
 *
 * A product keeps its own lint fences beside its code: `<group>/<product>/eslint.product.mjs`
 * default-exports a function of the shared boundary constants returning flat-config objects.
 * Anything a present policy does other than load and return an array stops lint naming the
 * file, because a fence that silently fails to load is a fence that cannot fail.
 *
 * @param {string | URL} workspace The repository root the product directories sit under.
 * @param {SharedConstraints} shared Passed to each policy function unchanged.
 * @returns {Promise<FlatConfigObject[]>} The discovered objects, ready to spread.
 * @throws When a group directory cannot be read, or a present policy fails to load, does not
 *   default-export a function, throws when called, or returns anything but an array.
 */
export async function readProductPolicies(workspace, shared) {
  const root = workspacePath(workspace);
  /** @type {FlatConfigObject[]} */
  const policies = [];
  for (const group of POLICY_GROUPS) {
    const groupPath = join(root, group);
    const products = (await readdir(groupPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const product of products) {
      const policyPath = join(groupPath, product, POLICY_FILE);
      if (!(await isPolicyPresent(policyPath))) continue;
      let loaded;
      try {
        loaded = await import(pathToFileURL(policyPath).href);
      } catch (failure) {
        // Proof: with absence decided here by `errorCode(failure) === 'ERR_MODULE_NOT_FOUND'`
        // instead of by the `stat` above, a probe policy importing `this-package-does-not-exist`
        // made `probe-app:lint` exit 0 with every fence silently gone, failing the nested-import
        // negative on `Expected: not 0 · Received: 0`.
        // Proof: with this rethrow replaced by a bare `continue`, a chmod-000 policy exited 0
        // rather than naming the file, failing the unreadable negative the same way (2026-09-15).
        throw new Error(`cannot load product lint policy ${policyPath}`, { cause: failure });
      }
      if (typeof loaded.default !== 'function') {
        // Proof: with this check removed, a policy spelled `export default []` still failed the
        // lint, but on `TypeError: loaded.default is not a function` raised inside the root
        // config, which names neither the contract nor the file (2026-09-15).
        throw new Error(`${policyPath} must default-export a function of the shared constants`);
      }
      let configs;
      try {
        configs = loaded.default(shared);
      } catch (failure) {
        // Proof: with this call left unwrapped, a probe policy throwing
        // `probe policy refuses to compose` failed `probe-app:lint` with that bare message and
        // named the file only in a stack frame, so the negative's
        // `cannot evaluate product lint policy` assertion failed (2026-09-16).
        throw new Error(`cannot evaluate product lint policy ${policyPath}`, { cause: failure });
      }
      if (!Array.isArray(configs)) {
        // An `async` policy lands here too: it returns a promise, not an array, and the message
        // has to say so rather than read as if the function returned the wrong element type.
        // Proof: with this check removed, a policy returning a bare object failed on
        // `TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function`
        // from the push below, naming neither the contract nor the file (2026-09-15).
        throw new Error(`${policyPath} must return an array of flat-config objects synchronously`);
      }
      policies.push(...configs);
    }
  }
  return policies;
}
