import { type } from '@wbs/validation';

export * from './decode-record';
export * from './records';

const IndexPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[*?[\]{}\\])(?!.*\/\/)(?!.*\/$).+$/;
const StableId = type(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
// Proof: widening this to arbitrary nonempty text let `../outside.ts` pass metadata; the CLI
// reached an unrelated missing `apps/alpha/README.md#public-api` anchor instead of refusing here.
const IndexPath = type(IndexPathPattern).narrow((path, context) =>
  !path.includes('\u0000') && path.split('/').every((segment) => segment !== '.')
    ? true
    : context.mustBe('a canonical index-relative path'),
);
const Explanation = type('string>=1').narrow((explanation, context) =>
  explanation.trim().length > 0 ? true : context.mustBe('a nonblank explanation'),
);

const ExactIndexMembership = type({ kind: "'path'", path: IndexPath }).onUndeclaredKey('reject');
const DirectoryIndexMembership = type({
  kind: "'directory-prefix'",
  prefix: IndexPath,
  exclusions: IndexPath.array(),
})
  .onUndeclaredKey('reject')
  .narrow((membership, context) =>
    // Proof: bypassing this guard made the outside-directory-exclusion production CLI exit 0
    // and report `docs/guide.md` as owned (expected exit 1, received 0).
    membership.exclusions.every(
      (excluded) => excluded !== membership.prefix && excluded.startsWith(`${membership.prefix}/`),
    )
      ? true
      : context.mustBe('directory exclusions below their declared prefix'),
  );

export const IndexMembership = ExactIndexMembership.or(DirectoryIndexMembership);
export type IndexMembership = typeof IndexMembership.infer;

const SectionInapplicability = type({
  section: "'relationships'|'invariants'|'checks'",
  reason: Explanation,
}).onUndeclaredKey('reject');

const ExternalConsumers = type({
  kind: "'none-known'",
  knowledgeLimit: Explanation,
})
  .onUndeclaredKey('reject')
  .or(
    type({
      kind: "'declared'",
      memberships: IndexMembership.array(),
      knowledgeLimit: Explanation,
    }).onUndeclaredKey('reject'),
  );

/** Version-1 machine envelope embedded once in an indexed README. */
export const IndexMetadata = type({
  // Proof: widening this to any number let version 2 reach membership inference; the CLI failed
  // later on `unindexed candidate path in README.md: apps/alpha/README.md` instead of metadata.
  schemaVersion: '1',
  moduleId: StableId,
  memberships: IndexMembership.array(),
  relationshipSelectors: StableId.array(),
  applicableChecks: StableId.array(),
  inapplicableSections: SectionInapplicability.array(),
  externalConsumers: ExternalConsumers,
})
  .onUndeclaredKey('reject')
  .narrow((metadata, context) => {
    // Proof: bypassing this guard made the duplicate-relationship-selector production CLI
    // exit 0 with an index report (expected exit 1, received 0).
    if (new Set(metadata.relationshipSelectors).size !== metadata.relationshipSelectors.length) {
      return context.mustBe('unique relationship selectors');
    }
    // Proof: deleting this guard made production lint certify two `check.fixture` references;
    // the duplicate-applicable-check oracle expected exit 1 and received accepted true.
    if (new Set(metadata.applicableChecks).size !== metadata.applicableChecks.length) {
      return context.mustBe('unique applicable checks');
    }
    const sections = metadata.inapplicableSections.map(({ section }) => section);
    // Proof: bypassing this guard made the duplicate-inapplicable-section production CLI
    // exit 0 with an index report (expected exit 1, received 0).
    if (new Set(sections).size !== sections.length) {
      return context.mustBe('unique inapplicable sections');
    }
    const relationshipsInapplicable = sections.includes('relationships');
    // Proof: bypassing this guard made both contradictory production CLIs exit 0: no selector
    // for applicable relationships, and a selector beside an inapplicability reason
    // (both expected exit 1, both received 0).
    if ((metadata.relationshipSelectors.length === 0) !== relationshipsInapplicable) {
      return context.mustBe(
        'relationship selectors or one explicit relationships inapplicability reason',
      );
    }
    const checksInapplicable = sections.includes('checks');
    // Proof: removing this completeness check made production lint certify an index with neither
    // an applicable check nor a checks-inapplicability reason; the oracle expected exit 1 and
    // received accepted true.
    if ((metadata.applicableChecks.length === 0) !== checksInapplicable) {
      return context.mustBe('applicable checks or one explicit checks inapplicability reason');
    }
    return true;
  });
export type IndexMetadata = typeof IndexMetadata.infer;
