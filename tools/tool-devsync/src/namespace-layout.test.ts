import { describe, expect, it } from 'bun:test';

import { findNamespaceLayoutViolations } from '../workspace-projects.mjs';

interface LayoutProject {
  readonly root: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly targets: Readonly<Record<string, object>>;
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
  project('tools/tool-devsync', 'tool-devsync', ['scope:infra', 'ring:adapter', 'runtime:bun']),
] as const;

describe('namespace layout validation', () => {
  it('accepts apps, every library ring directory and product-neutral tools', () => {
    expect(findNamespaceLayoutViolations(VALID_PROJECTS)).toEqual([]);
  });

  it('rejects ring, product and qualified-name disagreement with the directory', () => {
    expect(
      findNamespaceLayoutViolations([
        project('libs/wbs/adapters/core', 'core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:probe',
        ]),
        project('apps/wbs/be-01', 'be-01', [
          'scope:app',
          'ring:adapter',
          'runtime:bun',
          'product:probe',
        ]),
      ]),
    ).toEqual([
      'libs/wbs/adapters/core: directory product wbs disagrees with product:probe',
      'libs/wbs/adapters/core: directory adapters requires ring:adapter, found ring:application',
      'libs/wbs/adapters/core: project name must be wbs-core, found core',
      'apps/wbs/be-01: directory product wbs disagrees with product:probe',
      'apps/wbs/be-01: project name must be wbs-be-01, found be-01',
    ]);
  });

  it('requires exactly one tag on every project axis and product axis', () => {
    const valid = VALID_PROJECTS[1];
    for (const [axis, tags, expected] of [
      ['scope:', valid.tags.filter((tag) => !tag.startsWith('scope:')), 0],
      ['scope:', [...valid.tags, 'scope:app'], 2],
      ['ring:', valid.tags.filter((tag) => !tag.startsWith('ring:')), 0],
      ['ring:', [...valid.tags, 'ring:adapter'], 2],
      ['runtime:', valid.tags.filter((tag) => !tag.startsWith('runtime:')), 0],
      ['runtime:', [...valid.tags, 'runtime:bun'], 2],
      ['product:', valid.tags.filter((tag) => !tag.startsWith('product:')), 0],
      ['product:', [...valid.tags, 'product:probe'], 2],
    ] as const) {
      expect(
        findNamespaceLayoutViolations([project(valid.root, valid.name, tags)]),
        `${axis} ${String(expected)}`,
      ).toContain(`${valid.root}: expected exactly one ${axis} tag, found ${String(expected)}`);
    }
  });

  it('requires application ring and complete product/ring directory shapes', () => {
    expect(
      findNamespaceLayoutViolations([
        project('apps/wbs/be-01', 'wbs-be-01', [
          'scope:app',
          'ring:application',
          'runtime:bun',
          'product:wbs',
        ]),
        project('apps/be-01', 'be-01', ['scope:app', 'ring:adapter', 'runtime:bun', 'product:wbs']),
        project('libs/wbs/unknown/core', 'wbs-core', [
          'scope:shared',
          'ring:application',
          'runtime:isomorphic',
          'product:wbs',
        ]),
      ]),
    ).toEqual([
      'apps/wbs/be-01: applications require ring:adapter, found ring:application',
      'apps/be-01: applications require apps/<product>/<project>',
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
