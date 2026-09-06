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
  // The other half of the same criterion, and the half a review found missing:
  // the fence above stands in front of `src/controller`, so it says nothing
  // about what the modules a controller is *allowed* to import may themselves
  // import. `http/` is the framework-free layer every controller reaches the
  // outside through — `route.ts`, `response.ts`, `caller.ts`, `body-doc.ts`
  // and the second binder under `http/in-process/` — so `elysia` arriving in
  // any of them is the criterion failing one hop out, with the grep in AC 1
  // still clean.
  //
  // `http/elysia/` is excluded because it *is* the dialect: it is the one
  // place under `src/` outside `app.ts` that AC 1 lets import the framework.
  //
  // Measured rather than assumed, on a probe controller run through this
  // config (2026-09-06, h2puni, `~/t262-gate`): `import 'elysia'` errors and
  // `import '../http/elysia/query-schemas'` errors — so `**/http/elysia/*`
  // *does* match a `../`-relative specifier, contrary to the review's second
  // claim — while `import '@elysiajs/openapi'` did **not**, which is why
  // `@elysiajs/*` is now in both groups.
  //
  // What this still does not do, stated so nobody reads more into it: eslint
  // matches specifier strings, not a dependency graph, so a controller
  // importing some third module that imports the framework is caught by AC 1's
  // own `git grep` control and by `app.routes.test.ts`, not by this rule.
  // `openapi/openapi-plugin.ts` imports `@elysiajs/openapi` and is deliberately
  // outside this fence — it is a plugin `app.ts` mounts, not a module on any
  // controller's import path.
  //
  // It repeats the `bun:sqlite` restriction for the controller block's reason:
  // flat config replaces a rule's options per file rather than merging them, so
  // without the repeat every module under `http/` would silently lose it.
  //
  // `binder.contract.test.ts` is the second exclusion and the more interesting
  // one: it is AC 3's parameterised suite, whose whole job is to run the same
  // route list through BOTH binders, so it imports `./elysia/bind` on purpose.
  // Measured, not guessed — it is the one file in `http/` this block reddened
  // (`elysia/*` matches a `./elysia/…` specifier), and excluding the suite that
  // proves the seam is cheaper than a pattern that has to know about it.
  {
    files: ['apps/be-01/src/http/**/*.ts'],
    ignores: ['apps/be-01/src/http/elysia/**', 'apps/be-01/src/http/binder.contract.test.ts'],
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
              group: ['elysia', 'elysia/*', '@elysiajs/*'],
              allowTypeImports: false,
              message:
                'http/ is the framework-free layer — acceptance criterion #1 of the be-01 ' +
                'refactor. Only http/elysia/ names the framework; a module here that needs ' +
                'something from it takes a name the binder resolves instead ' +
                '(see QuerySchemaName in http/route.ts).',
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
