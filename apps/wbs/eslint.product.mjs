import tanstackQuery from '@tanstack/eslint-plugin-query';
import tanstackRouter from '@tanstack/eslint-plugin-router';
import drizzle from 'eslint-plugin-drizzle';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * WBS's own lint fences, loaded by the root flat config's product-policy discovery.
 *
 * The root config dynamically imports this file, so this file must not import the root
 * config back: the shared boundary constants arrive as the argument instead, and the
 * default export is the function that receives them rather than a plain array.
 *
 * Order is preserved from the root config, and the whole array is spread last, after the
 * generic test override: the store-memory test block below re-declares
 * `@nx/enforce-module-boundaries` in order to widen `allow`, which only holds while it
 * comes after the block it widens.
 */
export default ({
  browserAdapterConstraint,
  productRules,
  runtimeConstraints,
  scopeConstraints,
  testSourceFiles,
}) => [
  {
    ignores: [
      // This historical capture pin intentionally cannot compile against the
      // current ports; its sibling tsconfig documents the preserved exemption.
      'apps/wbs/be-01/tools/capture-capacity-oracle.ts',
    ],
  },

  {
    files: ['apps/wbs/fe-01/**/*.{ts,tsx}', 'libs/wbs/adapters/realtime/**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      '@tanstack/router': tanstackRouter,
      '@tanstack/query': tanstackQuery,
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
      // eslint-plugin-react-hooks 7 ships the React Compiler's own rules in
      // `recommended-latest`. Four of them describe what the *compiler* needs
      // in order to memoize a component, and this app does not run the
      // compiler: `refs` refuses a `ref.current` read during render, which is
      // the `live` seam every cell in `wbs-table.tsx` reads its live state
      // through on purpose (LLM_README's first landmine); `set-state-in-effect`
      // refuses the per-project re-reads of remembered layout that happen in
      // effects by design; `immutability` refuses a test harness that captures
      // a hook's API during render because reading it out of an effect would
      // be one render stale (`toasts.test.tsx`); and
      // `preserve-manual-memoization` reports "Compilation Skipped", which is
      // about a compilation that never runs. Measured on 2026-09-06 with all
      // four on: 41 + 15 + 2 + 1 findings, every one at a site that is
      // deliberate and documented where it stands. The other compiler rules
      // (`purity`, `set-state-in-render`, `error-boundaries`, `globals`, …)
      // stay on: they name faults regardless of the compiler.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      ...jsxA11y.flatConfigs.recommended.rules,
      ...tanstackRouter.configs['flat/recommended'].rules,
      ...tanstackQuery.configs['flat/recommended'].rules,
    },
    // The installed React's version, spelled rather than detected. ESLint 10
    // removed `context.getFilename`, and eslint-plugin-react 7.37's detection
    // path still calls it — `TypeError: contextOrFilename.getFilename is not
    // a function` on every file, which is how the whole lint target died on
    // the bump. A literal skips that path. `toolchain-pins.test.ts` holds it
    // equal to `react`'s installed version, so a React bump that forgets this
    // line fails the test tier rather than linting against the wrong React.
    settings: { react: { version: '19.2.8' } },
  },

  {
    files: ['libs/wbs/adapters/store-sqlite/src/**/*.ts'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': 'error',
      'drizzle/enforce-update-with-where': 'error',
    },
  },

  {
    files: ['apps/wbs/be-01/src/**/*.ts'],
    ignores: ['apps/wbs/be-01/src/repository/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*'],
              message: 'Import Drizzle only from the store-sqlite adapter.',
            },
            {
              group: ['@sinclair/typebox', '@sinclair/typebox/*'],
              message:
                'Declare wire schemas with ArkType; TypeBox would restore a second schema authority.',
            },
          ],
        },
      ],
    },
  },

  // `openDatabase` is where WAL, busy_timeout and foreign_keys are set and
  // asserted. Two of those three are per-*connection*, not stored in the
  // database file, so a second connection opened directly with `new
  // Database(...)` silently runs with busy_timeout=0 and foreign_keys=OFF —
  // and blue/green means two be-01 processes share one SQLite file, which is
  // exactly the situation those pragmas exist for.
  //
  // Nothing structural prevented that bypass: `openDatabase` is called from
  // `store-sqlite/migrate.ts`, so whoever first wires the
  // server to SQLite has to know to route through it. This makes the
  // compiler-adjacent tooling enforce it instead of a comment. Type-only
  // imports stay allowed — they cannot open a connection.
  // Proof: a production `direct-open-probe.ts` importing `Database` from
  // `bun:sqlite` failed `store-sqlite:lint` at 1:1 with this rule's
  // "Open connections through openDatabase() in store-sqlite/db.ts" diagnostic.
  {
    files: ['apps/wbs/be-01/src/**/*.ts', 'libs/wbs/adapters/store-sqlite/src/**/*.ts'],
    ignores: ['libs/wbs/adapters/store-sqlite/src/db.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun:sqlite',
              allowTypeImports: true,
              message:
                'Open connections through openDatabase() in store-sqlite/db.ts — it sets and ' +
                'asserts WAL, busy_timeout and foreign_keys, and busy_timeout/foreign_keys ' +
                'are per-connection, so a direct `new Database()` silently loses them.',
            },
          ],
        },
      ],
    },
  },

  // The controller directory owns no HTTP framework, and this is what makes
  // that true rather than aspirational.
  //
  // `http/route.ts` claimed an ESLint boundary held the line for the whole of
  // the be-01 hexagonal refactor. There was none: the check was
  // `git grep -l elysia apps/wbs/be-01/src/controller`, run by hand, and it stayed
  // green only because nobody ran it. Deleted schema and body-document helpers
  // under `http/elysia/` grew controller imports, so seven route modules loaded
  // the framework transitively for fourteen chunks while the acceptance
  // criterion read as met.
  //
  // Transitive is the whole point of the pattern list: banning `elysia` alone
  // would still have passed, because no controller named it directly. Anything
  // under `http/elysia/` is the framework's dialect by definition, so importing
  // one of those modules is importing the framework one hop out.
  //
  // Type-only imports are restricted too. A type import costs nothing at run
  // time and it is still the thing that failed the criterion, which is written
  // against the grep and not against the emitted bundle.
  //
  // This block repeats the `bun:sqlite` restriction from the block above,
  // because flat config replaces a rule's options per file rather than merging
  // them — without the repeat, controllers would silently lose it.
  {
    files: ['apps/wbs/be-01/src/controller/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun:sqlite',
              allowTypeImports: true,
              message:
                'Open connections through openDatabase() in store-sqlite/db.ts — it sets and ' +
                'asserts WAL, busy_timeout and foreign_keys, and busy_timeout/foreign_keys ' +
                'are per-connection, so a direct `new Database()` silently loses them.',
            },
          ],
          patterns: [
            {
              group: ['elysia', 'elysia/*', '@elysiajs/*', '**/http/elysia/*'],
              allowTypeImports: false,
              message:
                'A route module names no HTTP framework — acceptance criterion #1 of the ' +
                'be-01 refactor. Express the protocol through a shared EndpointShape and ' +
                'BoundEndpoint; keep framework behavior inside http/elysia/.',
            },
          ],
        },
      ],
    },
  },
  // The other half of the same criterion, and the half two reviews found
  // missing in turn: the fence above stands in front of `src/controller`, so it
  // says nothing about what the modules a controller is *allowed* to import may
  // themselves import.
  //
  // This block used to cover `http/**` only, on the reasoning that `http/` is
  // the layer every controller reaches the outside through. That was true and
  // still too narrow — it left every other directory under `src/` (`service/`,
  // `repository/`, `openapi/`, `realtime/`) unfenced, so a controller importing
  // a service that imports the framework passed both blocks. **The fence is now
  // the whole of `apps/wbs/be-01/src`, by exception rather than by inclusion** — so
  // no module under `src/` can name the framework in a static specifier unless
  // it is one of the three exceptions below, with no graph to walk and no second
  // tool to maintain.
  //
  // **What that does NOT buy, because a review found the comment here claiming
  // it did** (TASK-270 run 5, `queue/reviews/t270-r5-sol-3445accd.md`, measured
  // with probes now in `~/t270-probes/` on h2puni): this is not transitivity in
  // general. `import '../app'` from a fenced module raises nothing — and must
  // not, since `boot.ts` and a dozen suites build the app on purpose — so the
  // framework is one hop away through either exempt composition module.
  // `await import('elysia')` and `require('elysia')` raise nothing either; this
  // rule reads static import and export declarations only. The enforced claim
  // is therefore the narrow one, which is what AC 1's second branch asks for:
  // *no static specifier outside the exceptions resolves to the framework*.
  // `app.routes.test.ts` and the `git grep` control cover what this cannot.
  //
  // The exceptions are the three places that still name the framework:
  //
  // - `http/elysia/**` *is* the dialect; it is the one directory under `src/`
  //   that AC 1 lets import the framework.
  // - `app.ts` is the composition root — it is where the dialect is allowed to
  //   meet the endpoint table, and AC 1 has always named it.
  // - `openapi/openapi-plugin.ts` serves the generated document through Elysia
  //   and is not on a controller's import path.
  //
  // These three are exempt from **this block**, which means they are also exempt
  // from the `bun:sqlite` path it repeats. They are not unrestricted: the
  // `src/**` block above at `:147` still supplies them that same restriction,
  // measured by probe. Only `store-sqlite/src/db.ts` is exempt from `bun:sqlite`
  // outright, and that is by name in both blocks.
  // - `controller/**` is ignored *here* only because the block above already
  //   fences it with a message written for route authors. Flat config replaces
  //   a rule's options per file rather than merging them, so without this
  //   ignore the broader block would silently overwrite that message; the
  //   pattern list is deliberately identical either way, so nothing is lost.
  //
  // Measured on a probe controller run through this config (2026-09-06,
  // h2puni, `~/t262-gate`): `import 'elysia'`, a relative adapter import and
  // `import '@elysiajs/openapi'` all error. The package family remains fenced
  // after the OpenAPI plugin dependency was deleted.
  //
  // What this still does not do, stated so nobody reads more into it: eslint
  // matches specifier strings, not a dependency graph, so the guarantee stops
  // at this project's boundary. A cross-project edge is
  // `@nx/enforce-module-boundaries`' job, which *is* graph-transitive. Today
  // no shared library names the framework. The observability metrics collector
  // is framework-free; app composition and `http/elysia` own its HTTP routes.
  // Controllers reach `@wbs/auth`, `@wbs/contracts`, `@wbs/domain` and
  // `@wbs/validation`, none of which name Elysia.
  //
  // It repeats the `bun:sqlite` restriction for the controller block's reason:
  // flat config replaces a rule's options per file rather than merging them, so
  // without the repeat every module under `src/` would silently lose it.
  {
    files: ['apps/wbs/be-01/src/**/*.ts'],
    ignores: [
      'apps/wbs/be-01/src/controller/**',
      'apps/wbs/be-01/src/http/elysia/**',
      'apps/wbs/be-01/src/app.ts',
      'apps/wbs/be-01/src/openapi/openapi-plugin.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun:sqlite',
              allowTypeImports: true,
              message:
                'Open connections through openDatabase() in store-sqlite/db.ts — it sets and ' +
                'asserts WAL, busy_timeout and foreign_keys, and busy_timeout/foreign_keys ' +
                'are per-connection, so a direct `new Database()` silently loses them.',
            },
          ],
          patterns: [
            {
              group: ['elysia', 'elysia/*', '@elysiajs/*', '**/http/elysia/*'],
              allowTypeImports: false,
              message:
                'be-01 is framework-free below app.ts — acceptance criterion #1 of the ' +
                'be-01 refactor. This fence covers every static specifier under src/ outside ' +
                'the named exceptions. Only http/elysia/ names the framework; other modules ' +
                'express HTTP behavior through shared endpoint shapes and bindings.',
            },
          ],
        },
      ],
    },
  },
  // `store-sqlite/src/db.ts` is the one module the `bun:sqlite` message above points
  // *at*: `openDatabase()` lives there and it is what sets and asserts WAL,
  // busy_timeout and foreign_keys. Widening the fence to `src/**` above swept it
  // in for the first time — it sits under neither `controller/` nor `http/` — and
  // the gate caught it as the one red in `be-01:lint`.
  //
  // The carve-out is deliberately the *path* and not the whole rule: this block
  // re-declares the framework patterns unchanged, so `db.ts` is still fenced
  // against elysia, and only the restriction it exists to satisfy is lifted.
  // Flat config replaces a rule's options per file rather than merging them,
  // which is what makes that separation expressible at all — and it is why this
  // block must stay after the one above.
  {
    files: ['libs/wbs/adapters/store-sqlite/src/db.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['elysia', 'elysia/*', '@elysiajs/*', '**/http/elysia/*'],
              allowTypeImports: false,
              message:
                'be-01 is framework-free below app.ts — acceptance criterion #1 of the ' +
                'be-01 refactor. This module is exempt from the bun:sqlite restriction ' +
                'because it is openDatabase()’s own file, and from nothing else.',
            },
          ],
        },
      ],
    },
  },

  // Core and domain execute in every supported runtime. Static package
  // imports and ambient defaults are therefore adapter dependencies even when
  // the imported API happens to exist in today's Bun process. Tests are the
  // explicit composition boundary and are excluded below by their real tracked
  // suffixes; `testing/` holds their fixtures.
  {
    files: [
      'libs/wbs/application/core/src/**/*.{ts,tsx}',
      'libs/wbs/domain/domain/src/**/*.{ts,tsx}',
    ],
    ignores: [...testSourceFiles, '**/testing/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                'bun:*',
                'elysia',
                'elysia/*',
                '@elysiajs/*',
                'drizzle-orm',
                'drizzle-orm/*',
                'jose',
              ],
              message: 'Core and domain receive runtime behavior through ports.',
            },
            {
              group: ['@sinclair/typebox', '@sinclair/typebox/*'],
              message:
                'Declare wire schemas with ArkType; TypeBox would restore a second schema authority.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['Bun', 'process', 'fetch', 'setTimeout', 'setInterval', 'Buffer'].map((name) => ({
          name,
          message: 'Core and domain receive runtime behavior through ports.',
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: 'Core and domain receive fetch through a transport port.',
        },
        {
          selector:
            "MemberExpression[object.name='globalThis'][computed=true][property.value='fetch']",
          message: 'Core and domain receive fetch through a transport port.',
        },
      ],
    },
  },

  // The memory source is isomorphic, while its certification executes in Bun.
  // This one test-only edge admits the Bun kit without changing the source's
  // production runtime or allowing another Bun adapter into its graph.
  {
    files: ['libs/wbs/adapters/store-memory/src/**/*.test.ts'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['@wbs/conformance', '@wbs/conformance/*'],
          ignoredCircularDependencies: [['wbs-core', 'wbs-store-memory']],
          depConstraints: [
            browserAdapterConstraint,
            ...productRules,
            ...scopeConstraints,
            ...runtimeConstraints,
          ],
        },
      ],
    },
  },
];
