/** The four source-family kits owned by core extraction, independently enumerated. */
export const SOURCE_CONFORMANCE_CASES = [
  'steps.add',
  'steps.rename',
  'steps.rename:unknown',
  'estimates.set',
  'estimates.set:replace',
  'estimates.set:unknown_step',
  'estimates.remove',
  'directory.addTag',
  'directory.assign:unknown_person',
  'eventLog.recordEvent',
  'eventLog.rangeSince',
  'eventLog.pruneBeyond',
] as const;

/** The case states needed to prove that declaration did not replace execution. */
export interface SourceCaseReport {
  ran: readonly string[];
  skipped: readonly string[];
}

/**
 * Refuses a source report that omitted a registered source-family case.
 *
 * Expected cases live apart from kit registration so deleting a kit cannot
 * shrink the standard and its evidence together.
 */
export function certifySourceReport(source: string, report: SourceCaseReport): void {
  const reported = new Set([...report.ran, ...report.skipped]);
  const missing = SOURCE_CONFORMANCE_CASES.filter((id) => !reported.has(id));
  if (missing.length > 0) {
    throw new Error(`${source} certification missing cases: ${missing.join(', ')}`);
  }
}
