import type { PlanInputReads } from '@wbs/core';

export const CAPTURE_FIRST_READ = 'saved-plan-capture:first-project-read' as const;

export interface CaptureFirstReadEvidence {
  readonly projectId: string;
  readonly project: PlanInputReads['project'];
}

export interface CaptureReadSeam {
  afterFirstRead(evidence: CaptureFirstReadEvidence): Promise<void>;
}

export const inertMemoryCaptureReadSeam: CaptureReadSeam = {
  afterFirstRead: () => Promise.resolve(),
};
