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
  inapplicableSections: SectionInapplicability.array(),
  externalConsumers: ExternalConsumers,
})
  .onUndeclaredKey('reject')
  .narrow((metadata, context) => {
    if (new Set(metadata.relationshipSelectors).size !== metadata.relationshipSelectors.length) {
      return context.mustBe('unique relationship selectors');
    }
    const sections = metadata.inapplicableSections.map(({ section }) => section);
    if (new Set(sections).size !== sections.length) {
      return context.mustBe('unique inapplicable sections');
    }
    const relationshipsInapplicable = sections.includes('relationships');
    if ((metadata.relationshipSelectors.length === 0) !== relationshipsInapplicable) {
      return context.mustBe(
        'relationship selectors or one explicit relationships inapplicability reason',
      );
    }
    return true;
  });
export type IndexMetadata = typeof IndexMetadata.infer;
