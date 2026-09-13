import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/** Source revision and exact measurement code identity, captured before timing starts. */
export async function renderingProvenance() {
  const files = [
    'apps/fe-01/e2e/rendering-baseline.spec.ts',
    'apps/fe-01/e2e/rendering-fixture.ts',
    'apps/fe-01/e2e/rendering-evidence.ts',
  ];
  const hash = createHash('sha256');
  for (const path of files)
    hash
      .update(path)
      .update('\0')
      .update(await readFile(path));
  return {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    fixtureSha256: hash.digest('hex'),
    fixtureFiles: files,
  };
}

/** Flushes each observation before the next stage; an unfinished case stays visibly running. */
export async function createRenderingEvidence(path: string, metadata: Record<string, unknown>) {
  const samples: { stage: string; observation: unknown }[] = [];
  let stage = 'setup';
  const persist = (status: 'running' | 'complete') =>
    writeFile(path, JSON.stringify({ status, stage, metadata, samples }, null, 2));
  // Proof: suppressing this write failure made `unwritable evidence is a refused
  // measurement rather than a silent checkpoint` resolve instead of rejecting ENOENT.
  await persist('running');
  return {
    async record(nextStage: string, observation: unknown) {
      stage = nextStage;
      samples.push({ stage, observation });
      // Proof: omitting this flush made `a completed timing sample survives before
      // later measurement stages` receive stage setup instead of cold-context.
      await persist('running');
    },
    async finish() {
      await persist('complete');
    },
  };
}
