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

  {
    files: ['**/*.{test,spec,integration.test,property.test,contract.test}.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
];
