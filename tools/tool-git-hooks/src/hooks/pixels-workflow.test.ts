import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: { name?: string };
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { shard?: number[] } };
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'ci.yml',
);

const readWorkflow = (): Workflow => Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as Workflow;

describe('the CI pixels gate', () => {
  test('runs every browser shard and makes the stable pixels check depend on them', () => {
    const workflow = readWorkflow();
    const shardJob = workflow.jobs?.['pixels_shard'];
    const summaryJob = workflow.jobs?.['pixels'];
    const layoutStep = shardJob?.steps?.find(({ name }) => name === 'Layout gate');
    const artifactStep = shardJob?.steps?.find(({ uses }) =>
      uses?.startsWith('actions/upload-artifact@'),
    );

    expect(shardJob?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
    expect(layoutStep?.run).toBe('bun run e2e -- --shard=${{ matrix.shard }}/4');
    expect(artifactStep?.with?.name).toBe(
      'wbs-table-screenshot-${{ matrix.shard }}-${{ github.run_attempt }}',
    );
    expect(summaryJob?.needs).toBe('pixels_shard');
    expect(summaryJob?.if).toBe('${{ always() }}');
    expect(summaryJob?.steps?.find(({ name }) => name === 'Require every browser shard')?.run).toBe(
      'test "${{ needs.pixels_shard.result }}" = success',
    );
  });
});
