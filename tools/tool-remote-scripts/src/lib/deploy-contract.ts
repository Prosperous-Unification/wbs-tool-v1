/**
 * The vocabulary every side of a deploy has to agree about, in one place.
 *
 * Four projects speak it — `tool-dagger` builds and publishes, `tool-deploy`
 * orchestrates, `tool-remote-scripts` swaps on the server, `tool-smoke` checks
 * afterwards — and each of them had its own copy: `Tier` was declared four
 * times and written inline twice more, `Color` three times, and the image
 * names, container names and ports twice each. Two of those copies had to
 * agree or a deploy pushes an image the server will not run, which
 * `assertDigestRef` catches at runtime because nothing caught it at build time.
 *
 * It lives here, in the project that runs **on the server**, because that is
 * the leaf: the swap imports nothing from the tools that call it, and the tools
 * that call it all import this. The alias is `@wbs/deploy-contract`, which is
 * the public entry point the comments in `deploy.ts` and `install.ts` said did
 * not exist — while `deploy.ts:9` was already importing `@wbs/tool-env` out of
 * this same project.
 */

/** One of the three services a release moves. */
export type Tier = 'be' | 'gw' | 'fe';

/** Every tier, in the order a deploy considers them. */
export const TIERS: readonly Tier[] = ['be', 'gw', 'fe'];

/**
 * The two colours a tier alternates between.
 *
 * Nothing here ever defaults to one of them: the live colour swaps with every
 * deploy, so a default would eventually run against the dead colour with
 * nothing on screen to say so — `resolveColor`'s argument, and it applies to
 * every reader of this type.
 */
export type Color = 'blue' | 'green';

/** The app name a tier is known by, independent of colour. */
export const APP_NAME: Record<Tier, string> = { be: 'be-01', gw: 'gw-01', fe: 'fe-01' };

/**
 * The image name a tier's release is published under.
 *
 * The one that had to agree in two places: `tool-dagger` builds the ref and
 * `swap.js` refuses a ref that does not name the tier it was asked to swap, so
 * a drift between the two copies would have passed the build and failed the
 * deploy — on the server, mid-swap.
 */
export const IMAGE_NAME: Record<Tier, string> = {
  be: 'wbs-be-01',
  gw: 'wbs-gw-01',
  fe: 'wbs-fe-01',
};

/**
 * The port each tier's app listens on **inside** its container.
 *
 * Read by the swap's health gate (a direct container-IP fetch), by the rendered
 * `reverse_proxy` targets, by the deploy's own in-network smoke URL, and by
 * `tool-smoke` itself. Four readers, and they were three copies of these three
 * numbers.
 */
export const PORT: Record<Tier, number> = { be: 3100, gw: 3200, fe: 80 };

/** One file the server executes, as the installer and the deploy both name it. */
export interface BundleFile {
  /** Local `dist/` path, relative to the repo root — the build host's cwd. */
  local: string;
  /**
   * Where it goes on the server, **relative to the environment root**.
   *
   * Relative and never absolute, because each environment executes its own
   * copy: dev's bundle is updated without reinstalling prod's underneath a
   * running prod swap. {@link bundleFilesFor} is what makes it a path.
   */
  remote: string;
}

/**
 * The two files the server actually executes: `swap.js`, run directly by the
 * host's bun for every tier's swap, and `smoke.js`, run in an ephemeral
 * container after every deploy.
 *
 * **One copy since 2026-09-02**, and the two it replaced disagreed about the
 * shape of `remote`: `tool-deploy` held them root-relative and made them
 * absolute per environment, while `tool-remote-scripts`'s installer held them
 * absolute from its own `WBS_ENV`-derived root and offered no way to say which
 * environment it meant. So the deploy checked dev's bundle and told the
 * operator to run an installer that would write prod's — see
 * `install.ts`'s `--env`.
 *
 * The comment justifying that duplication said no `@wbs/*` entry point existed
 * for this project. It was already false when it was written: `deploy.ts:9`
 * imports one.
 */
export const BUNDLE_FILES: readonly BundleFile[] = [
  { local: 'dist/tool-remote-scripts/swap.js', remote: '/bin/swap.js' },
  { local: 'dist/tool-smoke/smoke.js', remote: '/bin/smoke.js' },
];

/** {@link BUNDLE_FILES} with their `remote` resolved against one environment's root. */
export function bundleFilesFor(root: string): BundleFile[] {
  return BUNDLE_FILES.map((file) => ({ local: file.local, remote: `${root}${file.remote}` }));
}

export { writeAtomic } from './atomic';
export { withLock } from './lock';
export { decodeSolverSupervisorConfig } from './solver-supervisor-config';
export {
  SOLVER_SUPERVISOR_BUN,
  SOLVER_SUPERVISOR_BUNDLE,
  SOLVER_SUPERVISOR_CONFIG,
  SOLVER_SUPERVISOR_SERVICE,
  SOLVER_SUPERVISOR_SOCKET,
} from './solver-supervisor-install-contract';
