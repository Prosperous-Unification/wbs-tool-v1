import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'bun:test';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const services = [
  'assumed-assignee',
  'auth.service',
  'broadcast',
  'calendar-marker.service',
  'capacity.service',
  'clean-name',
  'compensating',
  'dependency',
  'directory-usage',
  'directory.service',
  'gateway-broadcaster',
  'history.service',
  'login-throttle',
  'numbered-work-item',
  'optimizer-trigger-broadcaster',
  'plan-command',
  'plan-commands',
  'priority-band.service',
  'project.service',
  'replay-buffer',
  'replay-orchestrator',
  'retention-job',
  'retention-timer',
  'roll-up',
  'saved-plan-default-name',
  'saved-plan-input',
  'saved-plan-quota',
  'saved-plan-retry',
  'saved-plan-schedule-body',
  'saved-plan-schedule',
  'saved-plan.service',
  'step.service',
  'work-item.service',
];

// Proof: importing be-01's repository/schema from adjacent
// gateway-broadcaster.ts failed core:lint at that production import with
// @nx/enforce-module-boundaries: "Projects cannot be imported by a relative or
// absolute path, and must begin with a npm scope" (2026-09-09).
it('keeps extracted production services inside the core boundary', async () => {
  const files = services.map((name) => `${root}/libs/core/src/service/${name}.ts`);
  for (const file of files) expect(existsSync(file), file).toBe(true);
  const lint = new ESLint({ cwd: root });
  const checked = await lint.lintFiles(files);
  expect(checked.flatMap((file) => file.messages)).toEqual([]);
}, 60_000);
