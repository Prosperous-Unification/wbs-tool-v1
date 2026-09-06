import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import tanstackRouter from '@tanstack/eslint-plugin-router';
import tanstackQuery from '@tanstack/eslint-plugin-query';
import drizzle from 'eslint-plugin-drizzle';
import unusedImports from 'eslint-plugin-unused-imports';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import jsdoc from 'eslint-plugin-jsdoc';
import prettier from 'eslint-config-prettier';
import nxPlugin from '@nx/eslint-plugin';

const nxRules = {
  '@nx/enforce-module-boundaries': [
    'error',
    {
      enforceBuildableLibDependency: true,
      allow: [],
      depConstraints: [
        { sourceTag: 'scope:app', onlyDependOnLibsWithTags: ['scope:shared'] },
        { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
        { sourceTag: 'scope:infra', onlyDependOnLibsWithTags: ['scope:shared', 'scope:infra'] },
        {
          sourceTag: 'runtime:browser',
          onlyDependOnLibsWithTags: ['runtime:browser', 'runtime:isomorphic'],
        },
        {
          sourceTag: 'runtime:bun',
          onlyDependOnLibsWithTags: ['runtime:bun', 'runtime:isomorphic'],
        },
        { sourceTag: 'runtime:isomorphic', onlyDependOnLibsWithTags: ['runtime:isomorphic'] },
      ],
    },
  ],
};

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.nx/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.gen.ts',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@nx': nxPlugin,
      'unused-imports': unusedImports,
      'simple-import-sort': simpleImportSort,
      unicorn,
    },
    rules: {
      ...nxRules,
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: false, allowTernary: false, allowTaggedTemplates: false },
      ],
      'unused-imports/no-unused-imports': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/filename-case': ['error', { cases: { kebabCase: true } }],
    },
  },

  {
    files: ['apps/fe-01/**/*.{ts,tsx}', 'libs/realtime/**/*.{ts,tsx}'],
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
      ...jsxA11y.flatConfigs.recommended.rules,
      ...tanstackRouter.configs['flat/recommended'].rules,
      ...tanstackQuery.configs['flat/recommended'].rules,
    },
    settings: { react: { version: 'detect' } },
  },

  {
    files: ['apps/be-01/src/repository/**/*.ts'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': 'error',
      'drizzle/enforce-update-with-where': 'error',
    },
  },

  {
    files: ['apps/be-01/src/**/*.ts'],
    ignores: ['apps/be-01/src/repository/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['drizzle-orm/*', 'drizzle-orm'] }],
    },
  },

  // `openDatabase` is where WAL, busy_timeout and foreign_keys are set and
  // asserted. Two of those three are per-*connection*, not stored in the
  // database file, so a second connection opened directly with `new
  // Database(...)` silently runs with busy_timeout=0 and foreign_keys=OFF —
  // and blue/green means two be-01 processes share one SQLite file, which is
  // exactly the situation those pragmas exist for.
  //
  // Nothing structural prevented that bypass: `openDatabase` is currently
  // called from `repository/migrate.ts` alone, so whoever first wires the
  // server to SQLite has to know to route through it. This makes the
  // compiler-adjacent tooling enforce it instead of a comment. Type-only
  // imports stay allowed — they cannot open a connection.
  {
    files: ['apps/be-01/src/**/*.ts'],
    ignores: ['apps/be-01/src/repository/db.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun:sqlite',
              allowTypeImports: true,
              message:
                'Open connections through openDatabase() in repository/db.ts — it sets and ' +
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
  // `git grep -l elysia apps/be-01/src/controller`, run by hand, and it stayed
  // green only because nobody ran it. Two helper modules under `http/elysia/`
  // grew controller imports — `query-schemas.ts`, which imports the runtime `t`,
  // and the body-doc helpers, which took a type from the framework — so seven
  // route modules loaded the framework transitively for fourteen chunks while
  // the acceptance criterion read as met.
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
    files: ['apps/be-01/src/controller/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun:sqlite',
              allowTypeImports: true,
              message:
                'Open connections through openDatabase() in repository/db.ts — it sets and ' +
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
                'be-01 refactor. Express what the route needs against http/route.ts, and ' +
                'put anything in the framework’s dialect behind a name the binder resolves ' +
                '(see QuerySchemaName) or in a framework-free module under http/ ' +
                '(see http/body-doc.ts).',
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
  // the whole of `apps/be-01/src`, by exception rather than by inclusion** — so
  // no module under `src/` can name the framework in a static specifier unless
  // it is one of the four exceptions below, with no graph to walk and no second
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
  // The exceptions are the modules under `src/` that name the framework —
  // measured at `a2dd1153`, not assumed — plus one that imports the adapter:
  //
  //     git grep -lE "from '(elysia|elysia/[^']*|@elysiajs/[^']*)'|\
  //     from '[^']*http/elysia/" -- apps/be-01/src
  //     → app.ts, http/elysia/{bind,body-doc-conformance,query-schemas}.ts,
  //       openapi/openapi-plugin.ts
  //
  // - `http/elysia/**` *is* the dialect; it is the one directory under `src/`
  //   that AC 1 lets import the framework, and it covers three of the five.
  // - `app.ts` is the composition root — it is where the dialect is allowed to
  //   meet the route list, and AC 1 has always named it.
  // - `openapi/openapi-plugin.ts` imports `@elysiajs/openapi` and is a plugin
  //   `app.ts` mounts, not a module on any controller's import path.
  // - `http/binder.contract.test.ts` does not name the framework; it names the
  //   adapter. It is AC 3's parameterised suite, whose whole job is to run one
  //   route list through BOTH binders, so it imports `./elysia/bind` on purpose.
  //   Measured, not guessed — it was the one file in `http/` the narrower block
  //   reddened (`elysia/*` matches a `./elysia/…` specifier, and a `../elysia/…`
  //   one too).
  //
  // These four are exempt from **this block**, which means they are also exempt
  // from the `bun:sqlite` path it repeats. They are not unrestricted: the
  // `src/**` block above at `:147` still supplies them that same restriction,
  // measured by probe. Only `repository/db.ts` is exempt from `bun:sqlite`
  // outright, and that is by name in both blocks.
  // - `controller/**` is ignored *here* only because the block above already
  //   fences it with a message written for route authors. Flat config replaces
  //   a rule's options per file rather than merging them, so without this
  //   ignore the broader block would silently overwrite that message; the
  //   pattern list is deliberately identical either way, so nothing is lost.
  //
  // Measured on a probe controller run through this config (2026-09-06,
  // h2puni, `~/t262-gate`): `import 'elysia'` errors and
  // `import '../http/elysia/query-schemas'` errors — so `**/http/elysia/*`
  // *does* match a `../`-relative specifier, contrary to a review's claim —
  // while `import '@elysiajs/openapi'` did **not**, which is why `@elysiajs/*`
  // is in both groups.
  //
  // What this still does not do, stated so nobody reads more into it: eslint
  // matches specifier strings, not a dependency graph, so the guarantee stops
  // at this project's boundary. A cross-project edge is
  // `@nx/enforce-module-boundaries`' job, which *is* graph-transitive. Today
  // the only library naming the framework is `libs/observability`, confined to
  // `src/server/` behind the `@wbs/observability/server` subpath, and only
  // `app.ts` imports it — controllers reach `@wbs/auth`, `@wbs/contracts`,
  // `@wbs/domain` and `@wbs/validation`, none of which name it.
  //
  // It repeats the `bun:sqlite` restriction for the controller block's reason:
  // flat config replaces a rule's options per file rather than merging them, so
  // without the repeat every module under `src/` would silently lose it.
  {
    files: ['apps/be-01/src/**/*.ts'],
    ignores: [
      'apps/be-01/src/controller/**',
      'apps/be-01/src/http/elysia/**',
      'apps/be-01/src/app.ts',
      'apps/be-01/src/openapi/openapi-plugin.ts',
      'apps/be-01/src/http/binder.contract.test.ts',
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
                'Open connections through openDatabase() in repository/db.ts — it sets and ' +
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
                'be-01 refactor, and it holds transitively only because this fence covers ' +
                'every module under src/. Only http/elysia/ names the framework; a module ' +
                'here that needs something from it takes a name the binder resolves instead ' +
                '(see QuerySchemaName in http/route.ts).',
            },
          ],
        },
      ],
    },
  },
  // `repository/db.ts` is the one module the `bun:sqlite` message above points
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
    files: ['apps/be-01/src/repository/db.ts'],
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

  // AGENTS.md R3: knowledge about a symbol lives in JSDoc on that symbol.
  //
  // Deliberately NOT `jsdoc/require-jsdoc`. A rule demanding a comment on every
  // export is satisfied by `/** The user service. */ class UserService` — it can
  // be silenced without conveying anything, so it cannot fail in the only sense
  // that matters. That is the exact defect class R5 exists to stop, and adding
  // it as an R3 enforcement would be self-defeating.
  //
  // These rules instead check that JSDoc which DOES exist is true: that its
  // parameter names match the signature, that its tags are real, and that it
  // does not restate types the compiler already knows. Whether a symbol needs
  // documenting at all stays a review judgement, as it has to.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { jsdoc },
    rules: {
      // A @param naming an argument that does not exist is worse than no
      // @param: it describes a signature that is not there.
      'jsdoc/check-param-names': 'error',
      'jsdoc/check-tag-names': ['error', { typed: true }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/no-undefined-types': 'off',
      // TypeScript owns the types. `@param {string} name` duplicates the
      // signature and goes stale independently of it.
      'jsdoc/no-types': 'error',
      // An empty `@param foo` or a bare `@returns` is the vacuous form again —
      // if the tag is present it has to carry information.
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/empty-tags': 'error',
      'jsdoc/no-multi-asterisks': 'error',
    },
  },

  {
    files: ['**/*.{test,spec,integration.test,property.test,contract.test}.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
];
