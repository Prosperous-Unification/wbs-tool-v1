import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import jsdoc from 'eslint-plugin-jsdoc';
import prettier from 'eslint-config-prettier';
import nxPlugin from '@nx/eslint-plugin';

import { readProductPolicies } from './tools/tool-devsync/product-policies.mjs';
import { productConstraints, readProjects } from './tools/tool-devsync/workspace-projects.mjs';

const productRules = productConstraints(await readProjects(import.meta.dirname));
// Proof: removing the generated rules from production, the general test
// override and the store-memory test override made the effective-config oracle
// fail on libs/wbs/application/core/src/index.ts, libs/wbs/application/core/src/example.test.ts and
// libs/wbs/adapters/store-memory/src/source.test.ts respectively (2026-09-14).

const browserAdapterConstraint = {
  allSourceTags: ['ring:adapter', 'runtime:browser'],
  onlyDependOnLibsWithTags: ['ring:domain', 'runtime:browser'],
};

const runtimeConstraints = [
  {
    sourceTag: 'runtime:browser',
    onlyDependOnLibsWithTags: ['runtime:browser', 'runtime:isomorphic'],
  },
  {
    sourceTag: 'runtime:bun',
    onlyDependOnLibsWithTags: ['runtime:bun', 'runtime:isomorphic'],
  },
  { sourceTag: 'runtime:isomorphic', onlyDependOnLibsWithTags: ['runtime:isomorphic'] },
];

// `scope:infra` is absent on purpose: `productConstraints` generates the one
// rule that governs it, holding a product-less tool to infra and the shared
// product instead of to every product's `scope:shared` library.
const scopeConstraints = [
  { sourceTag: 'scope:app', onlyDependOnLibsWithTags: ['scope:shared'] },
  { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
];

const testSourceFiles = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.property.test.ts'];

// A product's own lint fences live beside the product: `apps/<product>/eslint.product.mjs`
// and `libs/<product>/eslint.product.mjs` default-export a function of the shared boundary
// constants that returns flat-config objects. The function, rather than a plain array, is
// what keeps a product file out of a circular import with this one — discovery loads the
// product file dynamically, so a static import back would close the cycle.
//
// `readProductPolicies` passes over a product that ships no policy and stops lint on every
// other outcome, naming the file. It lives in `tools/tool-devsync/product-policies.mjs` so
// that its negatives run against this exact code rather than against a fixture's copy.
const productPolicies = await readProductPolicies(import.meta.dirname, {
  browserAdapterConstraint,
  productRules,
  runtimeConstraints,
  scopeConstraints,
  testSourceFiles,
});

const nxBoundaryOptions = {
  enforceBuildableLibDependency: true,
  allow: [],
  // Core's tests execute its ports over the memory adapter. Nx builds one
  // project graph across production and tests, so that permitted test edge
  // otherwise makes the adapter's required production edge back to core
  // look circular. Production core imports remain blocked by the ring rule.
  ignoredCircularDependencies: [['wbs-core', 'wbs-store-memory']],
  depConstraints: [
    // The rings, and the direction the whole ports-and-adapters split is
    // for: a domain lib may reach nothing but another domain lib, an
    // application lib may reach the domain and its peers, and an adapter
    // may reach anything because reaching for the world is what an adapter
    // is. `@nx/enforce-module-boundaries` matches on tags, so a project
    // carrying no `ring:` is not constrained by any of these — which is why
    // `workspace-targets.test.ts` fails on one.
    { sourceTag: 'ring:domain', onlyDependOnLibsWithTags: ['ring:domain'] },
    {
      sourceTag: 'ring:application',
      onlyDependOnLibsWithTags: ['ring:domain', 'ring:application'],
    },
    {
      sourceTag: 'ring:adapter',
      onlyDependOnLibsWithTags: ['ring:domain', 'ring:application', 'ring:adapter'],
    },
    browserAdapterConstraint,
    ...productRules,
    ...scopeConstraints,
    ...runtimeConstraints,
  ],
};

const nxRules = {
  '@nx/enforce-module-boundaries': ['error', nxBoundaryOptions],
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
      // A binding kept for its name — a helper parameter that documents what
      // its caller hands over, a rest-destructure's discarded key — is spelled
      // with a leading underscore or as a rest sibling rather than acknowledged
      // with `void x;`: typescript-eslint 8.69's `no-meaningless-void-operator`
      // reads that idiom as the fault it is named for, and its autofix leaves a
      // bare expression statement behind (21 sites, 2026-09-06).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
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

  // TypeBox was the handwritten wire-schema authority. The endpoint contract
  // now derives validators and JSON Schema from one ArkType declaration, so a
  // new TypeBox import would recreate the two-authority drift D16 removed.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
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

  /**
   * A test composes what it is testing, and a fixture is what it composes with.
   *
   * The **ring** constraint is off for test files and for `testing/` fixtures,
   * and nothing else is: the runtime constraints still apply, so a browser
   * project's test still cannot pull in a Bun-only lib. Without this a domain
   * or application project could not have a test that builds the adapter it is
   * being tested over — which is the one composition that proves the port is a
   * port rather than a name (plan §2, "Test files are exempt").
   *
   * The exemption stops at the production file beside them: §3.5 #13 and #15
   * are the two negatives that say so, and both are watched in this change's
   * `verify.md`.
   */
  {
    files: [...testSourceFiles, '**/testing/**/*.{ts,tsx}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
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

  // `tool-remote-scripts`' supervisor host tooling and `tools/dev`'s corpus writers are WBS
  // code misfiled as infra; relocating them under `apps/wbs` is queued in
  // `docs/refactoring/tasks.md` as "Solver host tooling relocation". Until then the
  // exception is scoped to `tools/**` rather than named at either `allow: []` above, because
  // `allow` is matched on the import specifier alone: a repository-wide entry would also let
  // `libs/wbs/domain` production reach the supervisor protocol, which `eslint-boundaries.test.ts`
  // proves must stay refused.
  //
  // An `allow` entry carrying no `*` is an unanchored regular expression — `@nx/eslint-plugin`
  // tests it with `new RegExp(entry).test(importSpecifier)` — so the bare alias would also excuse
  // every subpath of it. Both entries are anchored so the excuse is the exact specifier and
  // nothing else; `workspace-projects.test.ts` refuses the same subpaths against the real Nx
  // graph independently of this list.
  //
  // Flat config replaces a rule's options per file rather than merging them, so this block
  // carries the whole option set and has to follow both generic blocks above.
  // `eslint-boundaries.test.ts` pins the list and fails once an entry stops being imported.
  {
    files: ['tools/**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          ...nxBoundaryOptions,
          // Proof: with these two entries spelled bare, a `@wbs/domain/workday` import linted as
          // `tools/tool-smoke/src/color.ts` produced no boundary diagnostic at all, failing the
          // subpath negative in `eslint-boundaries.test.ts` on `Expected to contain:
          // "@nx/enforce-module-boundaries" · Received: [ "@typescript-eslint/no-unused-vars",
          // "unused-imports/no-unused-imports" ]` (2026-09-16).
          allow: ['^@wbs/contracts/solver/supervisor-protocol$', '^@wbs/domain$'],
        },
      ],
    },
  },

  // Last, and not where the moved blocks used to sit: `store-memory`'s test block widens
  // `allow` on `@nx/enforce-module-boundaries`, and flat config replaces a rule's options
  // per file rather than merging them, so it only holds while it follows the generic test
  // override above. Spreading here preserves every moved block's order relative to that
  // override; the blocks that precede it here declare rules no generic block re-declares.
  ...productPolicies,

  prettier,
];
