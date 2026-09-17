import { describe, expect, it } from 'bun:test';

import { findNamespaceLayoutViolations, readProjects } from '../workspace-projects.mjs';

const WORKSPACE = new URL('../../../', import.meta.url);

interface LayoutProject {
  readonly root: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly targets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function project(root: string, name: string, tags: readonly string[]): LayoutProject {
  return { root, name, tags, targets: { lint: {} } };
}

const VALID_PROJECTS = [
  project('apps/wbs/be-01', 'wbs-be-01', [
    'scope:app',
    'ring:adapter',
    'runtime:bun',
    'product:wbs',
  ]),
  project('apps/wbs/fe-01', 'wbs-fe-01', [
    'scope:app',
    'ring:adapter',
    'runtime:browser',
    'product:wbs',
  ]),
  project('libs/wbs/domain/domain', 'wbs-domain', [
    'scope:shared',
    'ring:domain',
    'runtime:isomorphic',
    'product:wbs',
  ]),
  project('libs/wbs/application/core', 'wbs-core', [
    'scope:shared',
    'ring:application',
    'runtime:isomorphic',
    'product:wbs',
  ]),
  project('libs/wbs/adapters/store-sqlite', 'wbs-store-sqlite', [
    'scope:shared',
    'ring:adapter',
    'runtime:bun',
    'product:wbs',
  ]),
  // Appended rather than placed in root order: the tag-cardinality cases below
  // read `VALID_PROJECTS[2]`, so an earlier insertion would silently retarget
  // them from `wbs-domain` onto this project.
  //
  // Proof: renaming this fixture to the unqualified `validation` failed
  // `accepts both apps, every library ring directory and product-neutral tools`
  // with `libs/shared/domain/validation: project name must be
  // shared-validation, found validation` (2026-09-15).
  project('libs/shared/domain/validation', 'shared-validation', [
    'scope:shared',
    'type:validation',
    'runtime:isomorphic',
    'ring:domain',
    'product:shared',
  ]),
  project('tools/tool-devsync', 'tool-devsync', ['scope:infra', 'ring:adapter', 'runtime:bun']),
] as const;

describe('namespace layout validation', () => {
  it('accepts the complete actual workspace after the coordinated move', async () => {
    const projects = await readProjects(WORKSPACE);

    // Proof: before the coordinated move this owning Nx target named malformed
    // roots for all 18 WBS applications and libraries.
    expect(findNamespaceLayoutViolations(projects)).toEqual([]);
  });

  it('accepts both apps, every library ring directory and product-neutral tools', () => {
    expect(findNamespaceLayoutViolations(VALID_PROJECTS)).toEqual([]);
  });

  it('rejects a library ring that disagrees with its directory', () => {
    expect(
      findNamespaceLayoutViolations([
        project('libs/wbs/adapters/core', 'wbs-core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:wbs',
        ]),
      ]),
    ).toContain(
      'libs/wbs/adapters/core: directory adapters requires ring:adapter, found ring:application',
    );
  });

  it('rejects application and library products that disagree with their directories', () => {
    expect(
      findNamespaceLayoutViolations([
        project('apps/wbs/be-01', 'wbs-be-01', [
          'scope:app',
          'ring:adapter',
          'runtime:bun',
          'product:probe',
        ]),
        project('libs/wbs/application/core', 'wbs-core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:probe',
        ]),
      ]),
    ).toEqual([
      'apps/wbs/be-01: directory product wbs disagrees with product:probe',
      'libs/wbs/application/core: directory product wbs disagrees with product:probe',
    ]);
  });

  it('rejects unqualified application and library Nx names', () => {
    expect(
      findNamespaceLayoutViolations([
        project('apps/wbs/be-01', 'be-01', [
          'scope:app',
          'ring:adapter',
          'runtime:bun',
          'product:wbs',
        ]),
        project('libs/wbs/application/core', 'core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:wbs',
        ]),
      ]),
    ).toEqual([
      'apps/wbs/be-01: project name must be wbs-be-01, found be-01',
      'libs/wbs/application/core: project name must be wbs-core, found core',
    ]);
  });

  const valid = VALID_PROJECTS[2];
  for (const [axis, state, tags, count] of [
    ['scope:', 'absent', valid.tags.filter((tag) => !tag.startsWith('scope:')), 0],
    ['scope:', 'duplicate', [...valid.tags, 'scope:app'], 2],
    ['ring:', 'absent', valid.tags.filter((tag) => !tag.startsWith('ring:')), 0],
    ['ring:', 'duplicate', [...valid.tags, 'ring:adapter'], 2],
    ['runtime:', 'absent', valid.tags.filter((tag) => !tag.startsWith('runtime:')), 0],
    ['runtime:', 'duplicate', [...valid.tags, 'runtime:bun'], 2],
    ['product:', 'absent', valid.tags.filter((tag) => !tag.startsWith('product:')), 0],
    ['product:', 'duplicate', [...valid.tags, 'product:probe'], 2],
  ] as const) {
    it(`rejects ${state === 'absent' ? 'an' : 'a'} ${state} ${axis} tag`, () => {
      expect(
        findNamespaceLayoutViolations([project(valid.root, valid.name, tags)]),
        `${axis} ${String(count)}`,
      ).toContain(`${valid.root}: expected exactly one ${axis} tag, found ${String(count)}`);
    });
  }

  it('requires applications in the adapter ring with product-qualified names', () => {
    expect(
      findNamespaceLayoutViolations([
        project('apps/wbs/be-01', 'wbs-be-01', [
          'scope:app',
          'ring:application',
          'runtime:bun',
          'product:wbs',
        ]),
        project('apps/wbs/be-01', 'be-01', [
          'scope:app',
          'ring:adapter',
          'runtime:bun',
          'product:wbs',
        ]),
      ]),
    ).toEqual([
      'apps/wbs/be-01: applications require ring:adapter, found ring:application',
      'apps/wbs/be-01: project name must be wbs-be-01, found be-01',
    ]);
  });

  it('requires libraries in a complete recognized ring shape', () => {
    expect(
      findNamespaceLayoutViolations([
        project('libs/wbs/unknown/core', 'wbs-core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:wbs',
        ]),
      ]),
    ).toEqual([
      'libs/wbs/unknown/core: libraries require libs/<product>/<domain|application|adapters>/<project>',
    ]);
  });

  it('requires infra adapter tools without a product tag', () => {
    expect(
      findNamespaceLayoutViolations([
        project('tools/probe', 'probe', [
          'scope:shared',
          'ring:domain',
          'runtime:bun',
          'product:wbs',
        ]),
      ]),
    ).toEqual([
      'tools/probe: tools require scope:infra, found scope:shared',
      'tools/probe: tools require ring:adapter, found ring:domain',
      'tools/probe: tools must not carry a product tag, found product:wbs',
    ]);
  });

  it('rejects a project outside the enumerated workspace groups', () => {
    expect(
      findNamespaceLayoutViolations([
        project('packages/probe', 'probe', [
          'scope:shared',
          'ring:domain',
          'runtime:isomorphic',
          'product:wbs',
        ]),
      ]),
    ).toEqual(['packages/probe: project root must begin with apps/, libs/ or tools/']);
  });
});
