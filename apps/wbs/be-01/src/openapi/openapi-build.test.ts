import { expect, test } from 'bun:test';

interface BuildTarget {
  options?: { commands?: readonly string[]; parallel?: boolean };
}

test('the be-01 build emits the generated OpenAPI document', async () => {
  const project = (await Bun.file(new URL('../../project.json', import.meta.url)).json()) as {
    targets?: { build?: BuildTarget };
  };
  const build = project.targets?.build;
  // Proof: before the emitter command joined the production build target, this
  // received undefined instead of an array containing the expected command.
  expect(build?.options?.commands).toContain(
    'bun apps/be-01/src/openapi/emit-openapi-cli.ts dist/apps/be-01/openapi.json',
  );
  expect(build?.options?.parallel).toBe(false);
});
