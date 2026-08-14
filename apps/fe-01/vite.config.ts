import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * What the edge does with a request, taught to the dev server on its own.
 *
 * `src/lib/api.ts` fetches same-origin paths and says why: one host serves the
 * app and proxies `/api/*` and `/ws`, so a configured base URL would be a
 * second source of truth. Every deployed environment gets that from Caddy
 * (`tools/tool-compose/src/templates/site.caddy.tmpl`), and dev-in-a-container
 * gets it from the same file — so nothing ever asked what a bare `bunx vite`
 * does with `/api/auth/register`. It serves `index.html` and answers 404, which
 * the app reports as "Something went wrong (http_404)".
 *
 * That is exactly the stack the layout gate starts: three servers, no edge.
 * Ten tests timed out in `beforeEach` waiting for a "New project" button behind
 * a signup that had 404'd. So the routing lives here too, over the same two
 * subtrees the template routes: `/api/*` to be-01 with its prefix intact, `/ws*`
 * to gw-01 with the upgrade forwarded. The two matchers do not have the same
 * shape, and the keys below do not either — see there.
 *
 * Proof: with this proxy removed, `bun run e2e` fails all ten tests in
 * `beforeEach` on `waiting for getByRole('button', { name: 'New project' })`,
 * the page snapshot showing `http_404` under the register form — watched on
 * h2puni, 2026-08-08, and in CI run 31215500819 before it existed.
 *
 * @throws When the app has no `.env`, rather than starting a dev server that
 * proxies nowhere. `bun run dev:setup` writes one; `nx run fe-01:e2e` runs that
 * first for the same reason. `vite preview` is a `serve` command too, so it
 * throws the same way on a checkout with no `.env`; nothing in this repo runs
 * it, and a preview that quietly proxied nowhere would be the worse default.
 */
function edgeRoutes(mode: string): Record<string, ProxyOptions> {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const backend = env['VITE_BE_URL'];
  const gateway = env['VITE_GW_URL'];
  // `loadEnv` is typed `Record<string, string>` and returns `undefined` for a
  // variable no `.env` set — the index signature is a lie the compiler cannot
  // see through, which is why the falsy check is on the value rather than a
  // `=== undefined` the type would call dead code. Empty and absent are the
  // same fault here anyway: a dev server that would proxy nowhere.
  if (!backend || !gateway) {
    throw new Error(
      `apps/fe-01/.env must set VITE_BE_URL and VITE_GW_URL; got ` +
        `VITE_BE_URL=${backend || '(unset)'} VITE_GW_URL=${gateway || '(unset)'}. ` +
        `Run \`bun run dev:setup\` to seed it from .env.example.`,
    );
  }
  return {
    // `handle`, not `handle_path`, in the Caddy template: be-01 mounts its
    // controllers under /api already, so the prefix is passed through.
    //
    // The key is a regex because a plain string one is a `startsWith` prefix
    // here (`doesProxyContextMatchUrl`, vite/src/node/server/middlewares/proxy.ts),
    // and `'/api'` would send `/apiary` to be-01 as well. Caddy's `/api/*` does
    // not: "/foo/* will not match /foo or /foobar" (its path matcher docs), so
    // both of those reach the SPA there. A key starting with `^` is compiled to
    // a RegExp instead, which is the same subtree.
    '^/api/': { target: backend },
    // `/ws*` in the template, not `/ws/*` — a prefix that takes the bare path
    // and anything under it. A string key already means exactly that, so this
    // one is faithful as it stands.
    '/ws': { target: gateway, ws: true },
  };
}

export default defineConfig(({ command, mode }) => ({
  // `src/styles.css` says which parts of Tailwind are imported and why the base
  // layer is not one of them. This plugin is what compiles it, in dev and in
  // build alike; `vitest.config.ts` deliberately does not carry it, so a unit
  // test importing a stylesheet gets Vitest's stub rather than compiled CSS —
  // `src/styles.test.ts` runs its own build for that reason.
  //
  // Editing this list changes the bundle, and until 2026-08-09 Nx could not see
  // that: `nx.json`'s `production` named input excluded
  // `{projectRoot}/vite.config.[jt]s`, so `nx run fe-01:build` answered from
  // cache with a bundle built by a different plugin list. Watched — this file
  // touched, `[local cache] … Nx read the output from the cache`, `dist`
  // untouched. The exclusion is gone; the run is in
  // `docs/plans/2026-08-08-tailwind-spike-verify.md`.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // **The module, not the barrel.** `libs/domain`'s index re-exports
      // `estimate.ts` as well, and the validators around it pull arktype into
      // whatever imports it — which is why every wire type in `src/lib/wbs-api.ts`
      // is declared by hand rather than imported. `workday.ts` is pure and
      // dependency-free, and the Gantt panel needs exactly the calendar rule
      // be-01 prints the Start and End columns with; a second copy of that rule
      // is a chart that disagrees with the columns it sits under.
      //
      // The path mapping that makes the same import typecheck is in
      // `tsconfig.base.json` and this app's three tsconfigs, which replace the
      // base's `paths` rather than adding to them. `tsconfig.app.json` traded
      // its `rootDir: "src"` for `noEmit: true` at the same time, and all
      // three of the following were watched on 2026-08-09:
      //
      // - `rootDir: "src"` back: `nx typecheck fe-01` fails on
      //   `wbs-table.tsx(9,33): error TS6059: File '…/libs/domain/src/
      //   workday.ts' is not under 'rootDir' '…/apps/fe-01/src'`.
      // - neither `rootDir` nor `noEmit`: typecheck passes and writes
      //   `workday.js` and `workday.js.map` into `libs/domain/src` — a build
      //   artefact in a source tree, from a target that only reads.
      // - as it stands: a deliberate `const x: number = 'not a number'`
      //   appended to `gantt-panel.tsx` still fails the target, on
      //   `gantt-panel.tsx(406,7): error TS2322`. `noEmit` did not make the
      //   gate vacuous, which is the property that matters (AGENTS.md R5, and
      //   the one vacuous check ever found in the gate itself).
      '@wbs/domain/workday': resolve(__dirname, '../../libs/domain/src/workday.ts'),
      // The same module-not-barrel import, one file along: `effective-team.ts`
      // is pure and dependency-free, and the rule it holds — a leaf's team is
      // its own label or the nearest ancestor's — is the one be-01 pools on.
      // A second copy of it here is a table that disagrees with the dates it
      // is printing.
      '@wbs/domain/effective-team': resolve(__dirname, '../../libs/domain/src/effective-team.ts'),
      // The same bargain a third time: `priority-band.ts` is four pure functions
      // and a constant, and the rule it holds — which band a number falls in —
      // is what be-01 validates a ladder against. A second copy here is a table
      // that names a priority differently from the API that stored it.
      '@wbs/domain/priority-band': resolve(__dirname, '../../libs/domain/src/priority-band.ts'),
    },
  },
  server: {
    port: 4200,
    // The dev server runs in a container behind the shared Caddy edge. The
    // default localhost bind is unreachable from another container, and Vite
    // rejects Host headers it was not told about -- which surfaces as a 403
    // from the proxy with nothing in Caddy's logs to explain it.
    host: '0.0.0.0',
    allowedHosts: ['dev.wbs.bulletpoints.club'],
    // Serve only. `vite build` has no proxy to configure, and the gate job
    // builds fe-01 on a checkout with no `.env` at all — reading one there
    // would turn this into a build that fails for want of a dev setting.
    proxy: command === 'serve' ? edgeRoutes(mode) : undefined,
  },
  build: { outDir: '../../dist/apps/fe-01', emptyOutDir: true },
}));
