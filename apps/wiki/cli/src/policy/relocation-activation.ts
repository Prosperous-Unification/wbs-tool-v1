import { parseOrThrow, type } from '@shared/validation';

import {
  ModuleMapping,
  OpaqueId,
  RelationshipDeclaration,
  RelativePath,
} from '../contracts/records';
import { hashBytes, hashCanonical, serializeCanonical } from '../evidence/content-manifest';
import type { CandidateEntry, CandidateSnapshot } from '../inventory/read-candidate';
import { AuditEvaluation, AuditReview } from '../review/audit';
import { selectedMembers } from './trust';

const GitIdentity = type(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

/**
 * Every way this command refuses to prepare a relocation activation, in the order the
 * preparation reaches them. Four codes cover more ground than the design named for them:
 * `R3` is a candidate that is not the committed tree the receipts will claim, so it refuses a
 * dirty checkout and equally a `--work` or `--destination` inside the candidate repository;
 * `R16` is a check that did not fully measure the candidate, so it refuses a non-zero exit and
 * equally a receipt carrying skips, which `validateEvidence` would reject later and dearer;
 * `R19` is a build environment that is not the candidate's own, so it refuses an operator Bun
 * other than the candidate's `.bun-version` ({@link assertPinnedRuntime}) and equally a trusted
 * node module that is absent, unreadable or a symlink rather than a real directory (the CLI's
 * `packageDirectory`);
 * `R21` requires the lineage source to already stratify every review the candidate policy names,
 * because the risk stratum is copied, never invented: the base activation's authority in base mode,
 * the operator's audit strata file in toolkit mode.
 */
export type RelocationRefusalCode =
  | 'R1'
  | 'R2'
  | 'R3'
  | 'R4'
  | 'R5'
  | 'R6'
  | 'R7'
  | 'R8'
  | 'R9'
  | 'R10'
  | 'R11'
  | 'R12'
  | 'R13'
  | 'R14'
  | 'R15'
  | 'R16'
  | 'R17'
  | 'R18'
  | 'R19'
  | 'R20'
  | 'R21';

/** A named refusal to prepare an activation; the message always names the offending id or path. */
export class RelocationRefusal extends Error {
  constructor(
    readonly code: RelocationRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RelocationRefusal';
  }
}

function refuse(code: RelocationRefusalCode, message: string): never {
  throw new RelocationRefusal(code, message);
}

const BoundarySelector = type({ kind: "'path'", value: RelativePath })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'prefix'", value: RelativePath }).onUndeclaredKey('reject'));
type BoundarySelectorValue = typeof BoundarySelector.infer;
const ExactTuple = type({
  path: RelativePath,
  mode: "'100644'|'100755'|'120000'|'160000'",
  blob: GitIdentity,
}).onUndeclaredKey('reject');

/**
 * The fields a relocation reasons about, read out of a policy this command never activates by
 * itself: {@link planRelocationActivation} produces an activation whose own launcher parses the
 * same bytes with the complete schema in `trust.ts`, and refuses (`R20`) when they disagree.
 */
const RelocationPolicyView = type({
  policyId: OpaqueId,
  boundaries: type({
    boundaryId: OpaqueId,
    selector: BoundarySelector,
    'sourceSelector?': BoundarySelector,
    baselineEntries: ExactTuple.array(),
    obligationIds: OpaqueId.array(),
  }).array(),
  obligations: type({
    obligationId: OpaqueId,
    boundaryId: OpaqueId,
    checkIds: OpaqueId.array(),
    reviewIds: OpaqueId.array(),
  }).array(),
  pilot: type({ sourceRevision: GitIdentity }),
  'relationshipRequest?': type({ 'declarationPaths?': RelativePath.array() }),
});
export type RelocationPolicy = typeof RelocationPolicyView.infer;

const BaseAuthorityView = type({ audit: AuditEvaluation });

/** One candidate file read at the candidate revision, addressed by its repository-relative path. */
export interface CandidateFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Where the lineage a preparation reasons against comes from.
 *
 * `base` is a relocation: an activation of an earlier commit of this repository exists, so the
 * candidate's policy and its module lineage are compared against it (`R4`-`R9`, `R11`-`R13`), its
 * validator entry must stay inside an enforced boundary (`R18`), and the audit strata are copied
 * from its authority (`R21`).
 *
 * `toolkit` is a consumer's FIRST activation, produced from a released toolkit
 * ({@link docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md}). There is no earlier
 * activation to compare against, so those refusals have nothing to measure and are skipped; the
 * validator is the toolkit's reviewed bundle rather than a rebuild of the consumer's entry, and
 * the audit strata are an operator-supplied file this tool validates by join and never invents.
 * Everything that measures the candidate itself still applies: `R1`-`R3`, `R10`, `R14`
 * ({@link assertMappingOwnership} — the mapping must cover the candidate's own boundaries),
 * `R15`-`R17`, `R19` and `R20`.
 */
export type RelocationBase =
  | {
      readonly kind: 'base';
      readonly policyBytes: Uint8Array;
      readonly mappingBytes: Uint8Array;
      readonly authorityBytes: Uint8Array;
      readonly validatorIdentity: string;
      /**
       * The candidate entry the validator is rebuilt from. It exists only here: toolkit mode
       * copies the toolkit's reviewed bundle instead of rebuilding, so there is no entry to place
       * inside a boundary and `R18` has nothing to measure.
       */
      readonly validatorEntry: string;
    }
  | {
      readonly kind: 'toolkit';
      readonly validatorIdentity: string;
      /** The operator's audit stratum table, carried into the authority unchanged. */
      readonly strata: typeof AuditEvaluation.infer.strata;
      /** Risk stratum per review id; a review absent here refuses (`R21`). */
      readonly obligationStrata: Readonly<Record<string, string>>;
    };

export interface RelocationSources {
  readonly base: RelocationBase;
  readonly candidate: {
    readonly sha: string;
    /** `readCandidate` at the candidate revision. */
    readonly tree: CandidateSnapshot;
    /** `readCandidate` at the candidate policy's `pilot.sourceRevision`. */
    readonly reviewed: CandidateSnapshot;
    readonly policyBytes: Uint8Array;
    readonly mappingBytes: Uint8Array;
    readonly mappingPath: string;
    readonly declarations: readonly CandidateFile[];
    readonly validatorIdentity: string;
  };
}

/**
 * Whether the resolved command reports skipped work on a channel this tool can read. `bun test`
 * prints a `N skip` / `N todo` summary and still exits 0; every other command family this policy
 * can name emits no skip channel at all, so an empty `skips` list is a contract-level claim about
 * the command rather than an observation — see docs/findings/checks-that-cannot-fail.md.
 */
export type SkipChannel = 'bun-test' | 'none';

export interface CheckCommand {
  readonly checkId: string;
  readonly command: string[];
  readonly skipChannel: SkipChannel;
}

export interface CheckPlan {
  readonly checks: CheckCommand[];
  readonly candidateIdentity: string;
}

export interface CheckRun {
  readonly checkId: string;
  readonly command: string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/** Recorded, not verified here: what the operator's environment was, as the receipts claim it. */
export interface RelocationAttestation {
  readonly resourceLane: string;
  readonly cwdIdentity: string;
  readonly toolIdentity: string;
}

export interface RelocationPlan {
  readonly ids: {
    readonly authorityId: string;
    readonly journalId: string;
    readonly ciBindingId: string;
    readonly localBindingId: string;
    readonly validatorId: string;
    readonly receiptId: string;
    readonly trustScope: 'trusted-harness' | 'external-verifier';
  };
  readonly roles: {
    readonly policy: Uint8Array;
    readonly mapping: Uint8Array;
    readonly evidence: Uint8Array;
    readonly authority: Uint8Array;
    readonly reviewReceipt: Uint8Array;
    readonly ciBinding: Uint8Array;
    readonly localBinding: Uint8Array;
  };
  readonly identities: {
    readonly policy: string;
    readonly mapping: string;
    readonly reviewReceipt: string;
    readonly validator: string;
  };
  readonly candidateIdentity: string;
  readonly changedValidator: boolean;
  readonly checkReceipts: { observationId: string; receipt: unknown }[];
}

const encoder = new TextEncoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(serializeCanonical(value));
}

function parseJson(bytes: Uint8Array, subject: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} is not UTF-8: ${detail}`, { cause });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`malformed ${subject}: ${detail}`, { cause });
  }
}

function policyOf(bytes: Uint8Array, subject: string): { json: unknown; view: RelocationPolicy } {
  const json = parseJson(bytes, subject);
  return { json, view: parseOrThrow(RelocationPolicyView, json) };
}

/** Reads the relocation-relevant fields of a trusted policy the caller holds as exact bytes. */
export function readRelocationPolicy(bytes: Uint8Array): RelocationPolicy {
  return policyOf(bytes, 'candidate trusted policy JSON').view;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strippedPolicy(json: unknown): unknown {
  if (!isPlainObject(json)) throw new Error('trusted policy JSON must be an object');
  const { relationshipRequest: _relationshipRequest, ...rest } = json;
  const boundaries = rest['boundaries'];
  if (!Array.isArray(boundaries)) throw new Error('trusted policy boundaries must be an array');
  return {
    ...rest,
    boundaries: boundaries.map((boundary) => {
      if (!isPlainObject(boundary)) throw new Error('trusted boundary must be an object');
      const { selector: _selector, sourceSelector: _sourceSelector, ...boundaryRest } = boundary;
      return boundaryRest;
    }),
  };
}

function firstDifference(left: unknown, right: unknown, path: string): string | undefined {
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const nested = firstDifference(left[key], right[key], path === '' ? key : `${path}.${key}`);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const nested = firstDifference(left[index], right[index], `${path}[${String(index)}]`);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  return serializeCanonical(left ?? null) === serializeCanonical(right ?? null) ? undefined : path;
}

function selectorText(selector: BoundarySelectorValue): string {
  return `${selector.kind} ${selector.value}`;
}

function selectsPath(selector: BoundarySelectorValue, path: string): boolean {
  return selector.kind === 'path'
    ? path === selector.value
    : path === selector.value || path.startsWith(`${selector.value}/`);
}

function sameSelector(left: BoundarySelectorValue, right: BoundarySelectorValue): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

/**
 * Refuses every candidate policy that is not exactly the base policy with boundaries relocated:
 * the only fields a relocation may change are `selector`, `sourceSelector` and the relationship
 * request, and a moved boundary must declare where it moved from and keep its reviewed baseline.
 * @throws {@link RelocationRefusal} `R4`-`R9`.
 */
export function assertRelocationPolicy(
  base: RelocationPolicy,
  baseJson: unknown,
  candidate: RelocationPolicy,
  candidateJson: unknown,
  reviewed: CandidateSnapshot,
  candidateMapping: typeof ModuleMapping.infer,
): void {
  const strippedBase = strippedPolicy(baseJson);
  const strippedCandidate = strippedPolicy(candidateJson);
  // Proof: forcing this comparison false let a candidate policy carrying an added
  // `obligation.fixture.injected` plan a complete activation; the R4 negative received
  // `Received function did not throw`.
  if (serializeCanonical(strippedBase) !== serializeCanonical(strippedCandidate)) {
    refuse(
      'R4',
      `candidate policy is not a relocation of the base policy: ${firstDifference(strippedBase, strippedCandidate, '') ?? '(unknown field)'}`,
    );
  }
  const baseBoundaries = new Map(
    base.boundaries.map((boundary) => [boundary.boundaryId, boundary]),
  );
  for (const boundary of candidate.boundaries) {
    const previous = baseBoundaries.get(boundary.boundaryId);
    // The canonical comparison above already refuses an unknown boundary id; this narrows the
    // lookup rather than adding a second rule.
    if (previous === undefined) {
      refuse(
        'R4',
        `candidate policy is not a relocation of the base policy: ${boundary.boundaryId}`,
      );
    }
    const moved = !sameSelector(previous.selector, boundary.selector);
    // Proof: forcing this refusal false let the renamed fixture boundary plan an activation with
    // no recorded source selector; the R5 negative received `Received function did not throw`.
    if (moved && boundary.sourceSelector === undefined) {
      refuse(
        'R5',
        `boundary moved without sourceSelector: ${boundary.boundaryId} ` +
          `(${selectorText(previous.selector)} -> ${selectorText(boundary.selector)})`,
      );
    }
    const sourceSelector = boundary.sourceSelector;
    if (sourceSelector !== undefined) {
      // Proof: forcing this comparison false let a boundary claim it moved from `src/third`; the
      // R6 negative then observed the later `boundary sourceSelector selects nothing in the base
      // baseline: boundary.fixture.module` refusal instead of this one.
      if (!sameSelector(previous.selector, sourceSelector)) {
        refuse(
          'R6',
          `boundary sourceSelector differs from the base selector: ${boundary.boundaryId}`,
        );
      }
      // Proof: forcing this refusal false let a boundary relocate a baseline that lies outside
      // the base selector entirely; the R7 negative received `Received function did not throw`.
      if (
        !previous.baselineEntries.some((baseline) => selectsPath(sourceSelector, baseline.path))
      ) {
        refuse(
          'R7',
          `boundary sourceSelector selects nothing in the base baseline: ${boundary.boundaryId}`,
        );
      }
    }
    const reviewedByPath = new Map(reviewed.entries.map((entry) => [entry.path, entry]));
    for (const baseline of boundary.baselineEntries) {
      const entry = reviewedByPath.get(baseline.path);
      // Proof: forcing this reconciliation false let a candidate whose `pilot.sourceRevision` was
      // bumped past the move plan an activation whose reviewed snapshot held none of its
      // baselines; the R8 negative then observed `mapping source revision differs from pilot
      // policy` instead of this refusal.
      if (entry?.mode !== baseline.mode || entry.blob !== baseline.blob) {
        refuse(
          'R8',
          `boundary baseline is absent from the reviewed snapshot ${candidate.pilot.sourceRevision}: ` +
            `${boundary.boundaryId} ${baseline.path}`,
        );
      }
    }
  }
  // Proof: forcing this comparison false let a mapping pinned to another revision plan an
  // activation admission would refuse at `trusted pilot module mapping source does not match pilot
  // policy`; the R9 negative received `Received function did not throw`.
  if (candidateMapping.sourceRevision !== candidate.pilot.sourceRevision) {
    refuse(
      'R9',
      `mapping source revision differs from pilot policy: ${candidateMapping.sourceRevision} != ${candidate.pilot.sourceRevision}`,
    );
  }
}

/**
 * Refuses a candidate whose own selector selects nothing at its own revision, with the text
 * admission raises (`trust.ts` `validateSelectedInputs`), so a policy that was never updated for
 * the move fails here instead of in CI.
 * @throws {@link RelocationRefusal} `R10`.
 */
export function assertSelectorsResolve(policy: RelocationPolicy, tree: CandidateSnapshot): void {
  for (const boundary of policy.boundaries) {
    // Proof: forcing this refusal false let a candidate whose selector still named `src/old` plan
    // an activation; the R10 negative then observed `module memberships do not equal any
    // boundary's selected members: module.fixture.module` instead of this refusal.
    if (selectedMembers(tree, boundary.selector).length === 0) {
      refuse(
        'R10',
        `trusted boundary selector selects no candidate input: ${boundary.boundaryId} ` +
          `(selector ${selectorText(boundary.selector)}); if the candidate ` +
          `moved these files, prepare a relocation activation from the candidate SHA: ` +
          `see docs/runbook-tool-wiki-activation.md#relocation`,
      );
    }
  }
}

function mappedPaths(
  tree: CandidateSnapshot,
  memberships: (typeof ModuleMapping.infer)['modules'][number]['memberships'],
  moduleId: string,
): string[] {
  const paths = new Set<string>();
  for (const membership of memberships) {
    const matches =
      membership.kind === 'path'
        ? tree.entries.filter(({ path }) => path === membership.path)
        : tree.entries.filter(
            ({ path }) =>
              (path === membership.prefix || path.startsWith(`${membership.prefix}/`)) &&
              !membership.exclusions.some(
                (excluded) => path === excluded || path.startsWith(`${excluded}/`),
              ),
          );
    // Proof: forcing this refusal false let a mapping left at the pre-move `src/old` prefix own
    // nothing at all; the membership negative then observed `module memberships do not equal any
    // boundary's selected members: module.fixture.module` instead of this refusal.
    if (matches.length === 0) {
      refuse(
        'R14',
        `module membership selects no candidate input: ${moduleId} ` +
          `(${membership.kind === 'path' ? membership.path : membership.prefix})`,
      );
    }
    for (const { path } of matches) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Refuses a candidate mapping whose module lineage does not account for the base activation's
 * modules. Purely base-relative, so only a relocation reaches it; the ownership rule admission
 * applies (`trust.ts` `validatePilotModuleMapping`) is {@link assertMappingOwnership}, which runs
 * in both modes.
 * @throws {@link RelocationRefusal} `R11`-`R13`.
 */
export function assertMappingLineage(
  baseMapping: typeof ModuleMapping.infer,
  candidateMapping: typeof ModuleMapping.infer,
): void {
  const baseModuleIds = new Set(baseMapping.modules.map(({ moduleId }) => moduleId));
  const candidateModuleIds = new Set(candidateMapping.modules.map(({ moduleId }) => moduleId));
  const claimedPredecessors = new Set<string>();
  for (const module of candidateMapping.modules) {
    for (const predecessorId of module.predecessorModuleIds) {
      claimedPredecessors.add(predecessorId);
      // Proof: forcing this resolution false let a module name `module.fixture.absent` as its
      // predecessor; the R11 negative received `Received function did not throw`.
      if (!baseModuleIds.has(predecessorId)) {
        refuse(
          'R11',
          `module names unresolved predecessor: ${module.moduleId} -> ${predecessorId}`,
        );
      }
    }
    // Proof: forcing this refusal false let `module.fixture.added` appear with no lineage at all;
    // the R12 negative then observed `module memberships do not equal any boundary's selected
    // members: module.fixture.added` instead of this refusal.
    if (!baseModuleIds.has(module.moduleId) && module.predecessorModuleIds.length === 0) {
      refuse('R12', `module is new to the mapping and names no predecessor: ${module.moduleId}`);
    }
  }
  for (const moduleId of baseModuleIds) {
    // Proof: forcing this refusal false let a candidate silently drop the base activation's
    // module; the R13 negative then observed `boundary has no module: boundary.fixture.module`
    // instead of this refusal.
    if (!candidateModuleIds.has(moduleId) && !claimedPredecessors.has(moduleId)) {
      refuse('R13', `base module has no successor in the candidate mapping: ${moduleId}`);
    }
  }
}

/**
 * Refuses a mapping that does not exactly cover its own policy's boundaries in its own tree: every
 * module owns the selected members of exactly one boundary, and every boundary has a module.
 *
 * This compares the candidate's mapping with the candidate's policy and the candidate's tree, so it
 * needs no earlier activation and applies to a consumer's first, toolkit-sourced activation as much
 * as to a relocation.
 * @throws {@link RelocationRefusal} `R14`.
 */
export function assertMappingOwnership(
  candidateMapping: typeof ModuleMapping.infer,
  policy: RelocationPolicy,
  tree: CandidateSnapshot,
): void {
  const claimedBoundaryIds = new Set<string>();
  for (const module of candidateMapping.modules) {
    const ownedPaths = mappedPaths(tree, module.memberships, module.moduleId);
    const boundaries = policy.boundaries.filter(
      (boundary) =>
        hashCanonical(
          selectedMembers(tree, boundary.selector)
            .map(({ path }) => path)
            .sort(),
        ) === hashCanonical(ownedPaths),
    );
    // Proof: forcing this refusal false let a mapping that excluded `src/new/project.json` reach
    // `boundaries[0]`; the R14 ownership negative observed `undefined is not an object
    // (evaluating 'boundaries[0].boundaryId')` instead of this refusal.
    if (boundaries.length !== 1) {
      refuse(
        'R14',
        `module memberships do not equal any boundary's selected members: ${module.moduleId}`,
      );
    }
    claimedBoundaryIds.add(boundaries[0].boundaryId);
  }
  for (const boundary of policy.boundaries) {
    // Proof: forcing this completeness check false let a boundary with no module at all plan an
    // activation; the R14 boundary negative received `Received function did not throw`.
    if (!claimedBoundaryIds.has(boundary.boundaryId)) {
      refuse('R14', `boundary has no module: ${boundary.boundaryId}`);
    }
  }
}

function orderedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

function policyCheckIds(policy: RelocationPolicy): string[] {
  return orderedIds(policy.obligations.flatMap(({ checkIds }) => checkIds));
}

function policyReviewIds(policy: RelocationPolicy): string[] {
  return orderedIds(policy.obligations.flatMap(({ reviewIds }) => reviewIds));
}

/**
 * Resolves each obligation's checks to the executable command the candidate declares for it, at
 * the candidate revision and only through the declaration files the pinned policy names.
 * @throws {@link RelocationRefusal} `R15` when a check resolves to no executable `nx-target` fact.
 */
export function deriveCheckCommands(
  policy: RelocationPolicy,
  declarations: readonly CandidateFile[],
): CheckCommand[] {
  const facts = new Map<string, (typeof RelationshipDeclaration.infer)['facts'][number]>();
  for (const declaration of declarations) {
    const decoded = parseOrThrow(
      RelationshipDeclaration,
      parseJson(declaration.bytes, `relationship declaration ${declaration.path}`),
    );
    for (const fact of decoded.facts) facts.set(fact.factId, fact);
  }
  return policyCheckIds(policy).map((checkId) => {
    const fact = facts.get(checkId);
    // Proof: forcing this refusal false let a check with no declared target reach command
    // derivation; the R15 negative observed `undefined is not an object (evaluating
    // 'fact.project')` instead of this refusal.
    if (fact?.kind !== 'nx-target') {
      refuse('R15', `check has no executable nx-target fact: ${checkId}`);
    }
    return {
      checkId,
      command: ['bunx', 'nx', 'run', `${fact.project}:${fact.target}`, '--skip-nx-cache'],
      skipChannel: skipChannelOf(fact.expectedConfiguration),
    };
  });
}

/**
 * Reads the skip channel out of the target configuration the pinned declarations file states.
 * The declaration is the reviewed record of what `nx run <project>:<target>` executes, and the
 * relationship extractor refuses a declaration that disagrees with the candidate's `project.json`.
 */
// Proof: returning `'none'` for every command left the skips unmeasured, and the Nx `bun test`
// target that reported one skipped test prepared, certified and tarred a complete activation;
// the skip negative expected exit 1 and received 0.
function skipChannelOf(expectedConfiguration: unknown): SkipChannel {
  const options = isPlainObject(expectedConfiguration)
    ? expectedConfiguration['options']
    : undefined;
  const command = isPlainObject(options) ? options['command'] : undefined;
  return typeof command === 'string' && /(?:^|\s|\/)bun\s+test(?:\s|$)/.test(command)
    ? 'bun-test'
    : 'none';
}

/**
 * The skipped work the command reported, as its own summary states it. `bun test` exits 0 with a
 * `N skip` / `N todo` line, so a receipt that claimed `skips: []` for it would make admission's
 * `receipt.skips.length === 0` rule (trust.ts `validateEvidence`) unfalsifiable for this tool.
 * @throws nothing; a command with no skip channel returns `[]`, which is a claim about the
 * command's contract, not a measurement — docs/findings/checks-that-cannot-fail.md.
 */
export function observedSkips(run: CheckRun, channel: SkipChannel): string[] {
  if (channel === 'none') return [];
  const plain = `${new TextDecoder().decode(run.stdout)}\n${new TextDecoder().decode(run.stderr)}`
    // Bun colours its summary, so the counts sit inside SGR escapes. The escape character is
    // built from its code point: a literal one in a regex is a lint error, and eslint constant-
    // folds the string form too.
    .replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  return [...plain.matchAll(/^\s*(\d+)\s+(skip|todo)\b/gm)]
    .filter(([, count]) => Number(count) > 0)
    .map(([, count, kind]) => `bun test: ${count} ${kind}`);
}

/**
 * Refuses a validator entry the candidate policy does not select, so the rebuilt `validator.mjs`
 * can only come from reviewed, boundary-owned source.
 * @throws {@link RelocationRefusal} `R18`.
 */
export function assertValidatorEntry(policy: RelocationPolicy, entry: string): void {
  // Proof: forcing this refusal false let the repository-root `nx.json` become the activation's
  // validator entry; the R18 negative received `Received function did not throw`.
  if (!policy.boundaries.some((boundary) => selectsPath(boundary.selector, entry))) {
    refuse('R18', `validator entry is outside the enforced boundary: ${entry}`);
  }
}

/**
 * Refuses an operator runtime other than the one the candidate pins, because the rebuilt
 * validator's digest is the bundle this Bun produces.
 * @throws {@link RelocationRefusal} `R19`.
 */
export function assertPinnedRuntime(actual: string, pinned: string): void {
  // Proof: forcing this refusal false accepted Bun 1.4.1 against the candidate's pinned 1.4.2,
  // so an unpinned runtime could build the activation's validator; the negative received
  // `Received function did not throw`.
  if (actual !== pinned.trim()) {
    refuse(
      'R19',
      `operator Bun differs from the candidate's .bun-version: ${actual} != ${pinned.trim()}`,
    );
  }
}

/** Derives the identity of the toolchain the check receipts claim, from the candidate's own pins. */
export function deriveToolIdentity(packageBytes: Uint8Array, bunVersion: string): string {
  const manifest = parseJson(packageBytes, 'candidate package manifest');
  const devDependencies = isPlainObject(manifest) ? manifest['devDependencies'] : undefined;
  const pin = (name: string): string => {
    const value = isPlainObject(devDependencies) ? devDependencies[name] : undefined;
    // Proof: forcing this refusal false let an absent pin reach the identity hash; the
    // tool-identity negative observed `canonical JSON cannot serialize undefined` instead of this
    // named refusal.
    if (typeof value !== 'string') {
      throw new Error(`candidate package manifest has no ${name} pin`);
    }
    return value;
  };
  return hashCanonical({ bun: bunVersion, nx: pin('nx'), typescript: pin('typescript') });
}

function candidateIdentityOf(snapshot: CandidateSnapshot): string {
  return hashCanonical({
    selection: snapshot.selection,
    entries: snapshot.entries,
    untracked: snapshot.untracked,
  });
}

/**
 * Reads the candidate policy, mapping and declarations at the candidate revision and returns the
 * commands whose receipts the activation will carry.
 *
 * Base mode reaches every refusal below. Toolkit mode ({@link RelocationBase}) has no earlier
 * activation, so the base-relative ones (`R4`-`R9`, `R11`-`R13`, `R18`) have nothing to compare
 * against and are skipped; `R10`, `R14` and `R15` measure the candidate alone and always run.
 * @throws {@link RelocationRefusal} `R4`-`R15` and `R18`.
 */
export function planRelocationChecks(sources: RelocationSources): CheckPlan {
  const candidate = policyOf(sources.candidate.policyBytes, 'candidate trusted policy JSON');
  const candidateMapping = parseOrThrow(
    ModuleMapping,
    parseJson(sources.candidate.mappingBytes, 'candidate module mapping JSON'),
  );
  // Toolkit mode has no earlier activation, so the lineage refusals have nothing to compare the
  // candidate against; every refusal that measures the candidate itself is below and still runs.
  // The order below is the order of the refusals' own Proof comments, and each one depends on it:
  // a selector that still names the pre-move directory must earn R10's runbook-pointing refusal
  // rather than the R14 membership refusal that miss also produces, and a module with no lineage
  // must earn R12 rather than the R14 refusal its absence also produces.
  const base = sources.base.kind === 'base' ? sources.base : undefined;
  const baseMapping =
    base === undefined
      ? undefined
      : parseOrThrow(ModuleMapping, parseJson(base.mappingBytes, 'base module mapping JSON'));
  if (base !== undefined) {
    const basePolicy = policyOf(base.policyBytes, 'base trusted policy JSON');
    assertRelocationPolicy(
      basePolicy.view,
      basePolicy.json,
      candidate.view,
      candidate.json,
      sources.candidate.reviewed,
      candidateMapping,
    );
  }
  assertSelectorsResolve(candidate.view, sources.candidate.tree);
  if (baseMapping !== undefined) assertMappingLineage(baseMapping, candidateMapping);
  // R14 compares the candidate's mapping with its own policy and tree, so it runs in both modes.
  assertMappingOwnership(candidateMapping, candidate.view, sources.candidate.tree);
  if (base !== undefined) assertValidatorEntry(candidate.view, base.validatorEntry);
  return {
    checks: deriveCheckCommands(candidate.view, sources.candidate.declarations),
    candidateIdentity: candidateIdentityOf(sources.candidate.tree),
  };
}

interface ContentInput {
  kind: 'content';
  inputId: string;
  path: string;
  mode: CandidateEntry['mode'];
  blob: string;
}

function contentInputs(
  snapshot: CandidateSnapshot,
  reviewed?: ReadonlyMap<string, ContentInput>,
): ContentInput[] {
  return snapshot.entries.map((entry, index) => ({
    kind: 'content',
    inputId:
      reviewed === undefined
        ? `content.${String(index)}`
        : (reviewed.get(entry.path)?.inputId ??
          `content.added.${hashBytes(entry.path).slice(0, 16)}`),
    path: entry.path,
    mode: entry.mode,
    blob: entry.blob,
  }));
}

type ContentChange =
  | { change: 'added'; inputId: string; current: ContentInput }
  | { change: 'changed'; inputId: string; reviewed: ContentInput; current: ContentInput }
  | { change: 'removed'; inputId: string; reviewed: ContentInput };

function contentChanges(
  reviewed: readonly ContentInput[],
  current: readonly ContentInput[],
): ContentChange[] {
  const reviewedById = new Map(reviewed.map((input) => [input.inputId, input]));
  const currentById = new Map(current.map((input) => [input.inputId, input]));
  const changes: ContentChange[] = [];
  for (const [inputId, input] of reviewedById) {
    const next = currentById.get(inputId);
    if (next === undefined) changes.push({ change: 'removed', inputId, reviewed: input });
    else if (next.blob !== input.blob || next.mode !== input.mode) {
      changes.push({ change: 'changed', inputId, reviewed: input, current: next });
    }
  }
  for (const [inputId, input] of currentById) {
    if (!reviewedById.has(inputId)) changes.push({ change: 'added', inputId, current: input });
  }
  return changes.sort((left, right) => (left.inputId < right.inputId ? -1 : 1));
}

/**
 * Refuses a review record that does not bind this exact candidate: it is operator attestation
 * this command records and never produces, so the only thing it can check is that the record
 * names this revision, this candidate identity and completed work for the policy's reviews.
 * @throws {@link RelocationRefusal} `R17`.
 */
export function assertReviewBinds(
  review: typeof AuditReview.infer,
  policy: RelocationPolicy,
  sha: string,
  identity: string,
): void {
  const mismatch = (field: string, expected: string, received: string): never =>
    refuse(
      'R17',
      `review record does not bind the candidate: ${field} expected ${expected} received ${received}`,
    );
  const reviewIds = policyReviewIds(policy);
  // Proof: forcing this comparison false let a review of `review.fixture.other` discharge this
  // policy's review; the negative received `Received function did not throw`.
  if (hashCanonical(reviewIds) !== hashCanonical([review.obligationId])) {
    mismatch('obligationId', reviewIds.join(',') || '(none)', review.obligationId);
  }
  // Proof: forcing this comparison false let the base revision's review record bind this
  // candidate; the negative received `Received function did not throw`.
  if (review.candidateIdentity !== identity) {
    mismatch('candidateIdentity', identity, review.candidateIdentity);
  }
  // Proof: forcing this comparison false let a review recorded against the base revision bind
  // this one; the negative received `Received function did not throw`.
  if (review.sourceBase !== sha) mismatch('sourceBase', sha, review.sourceBase);
  const subject = review.evidence.protocolEvidence.subject;
  // Proof: forcing this comparison false let a review whose subject named all-`f` content bind
  // this candidate; the negative received `Received function did not throw`.
  if (subject.contentIdentity !== identity) {
    mismatch('subject.contentIdentity', identity, subject.contentIdentity);
  }
  // Proof: forcing this comparison false let a generation-2 review bind the first-generation
  // audit this command derives; the negative received `Received function did not throw`.
  if (review.generation !== 1) mismatch('generation', '1', String(review.generation));
  for (const phase of ['cold', 'informed'] as const) {
    const status = review.evidence.phaseReceipts[phase].receipt.status;
    // Proof: forcing this comparison false let a `censored` informed phase discharge the review;
    // the negative received `Received function did not throw`.
    if (status !== 'completed') mismatch(`phaseReceipts.${phase}.status`, 'completed', status);
  }
  const scope = review.evidence.receipt.trust.scope;
  // Proof: forcing this comparison false let `local-cooperative` — a scope the binding schema
  // cannot express — reach the authority trust scope; the negative received
  // `Received function did not throw`.
  if (scope !== 'trusted-harness' && scope !== 'external-verifier') {
    mismatch('trust.scope', 'trusted-harness|external-verifier', scope);
  }
}

function receiptOf(
  run: CheckRun,
  channel: SkipChannel,
  sha12: string,
  identity: string,
  attestation: RelocationAttestation,
): unknown {
  // Proof: forcing this refusal false recorded a check that exited 1 as `status: passed`, and the
  // command prepared, certified and tarred the whole activation; the R16 negative expected exit 1
  // and received 0.
  if (run.exitCode !== 0) {
    refuse(
      'R16',
      `check failed: ${run.checkId} exit ${String(run.exitCode)}; stdout ${run.stdoutPath} stderr ${run.stderrPath}`,
    );
  }
  const skips = observedSkips(run, channel);
  // A receipt carrying skips can never discharge its obligation (trust.ts `validateEvidence`
  // requires `skips.length === 0`), so recording one only moves this refusal to the launcher
  // self-check after the archive root has been assembled.
  // Proof: forcing this refusal false wrote the measured `skips: ["bun test: 1 skip"]` into the
  // authority and the skip negative then observed `prepared activation is not certified by its
  // own launcher` — admission refusing the very receipt this check refuses earlier and cheaper.
  if (skips.length > 0) {
    refuse(
      'R16',
      `check skipped work: ${run.checkId} (${skips.join(', ')}); stdout ${run.stdoutPath} stderr ${run.stderrPath}`,
    );
  }
  return {
    schemaVersion: 1,
    receiptKind: 'check',
    receiptId: `receipt.${run.checkId}.${sha12}`,
    command: run.command,
    cwdIdentity: attestation.cwdIdentity,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    elapsedMs: Date.parse(run.endedAt) - Date.parse(run.startedAt),
    status: 'passed',
    exitCode: 0,
    candidateManifest: identity,
    toolIdentity: attestation.toolIdentity,
    resourceLane: attestation.resourceLane,
    stdoutArtifact: hashBytes(run.stdout),
    stderrArtifact: hashBytes(run.stderr),
    skips,
  };
}

function bindingRecord(
  scope: 'ci' | 'local-operator',
  bindingId: string,
  references: {
    authorityId: string;
    journalId: string;
    trustScope: string;
    validatorId: string;
    policyIdentity: string;
    mappingIdentity: string;
    authorityIdentity: string;
    validatorIdentity: string;
    mappingPath: string;
  },
): unknown {
  return {
    schemaVersion: 1,
    bindingId,
    trustScope: scope,
    policy: { path: 'policy.json', sha256: references.policyIdentity },
    pilotModuleMapping: {
      candidatePath: references.mappingPath,
      artifact: { path: 'mapping.json', sha256: references.mappingIdentity },
    },
    authority: {
      authorityId: references.authorityId,
      journalId: references.journalId,
      trustScope: references.trustScope,
      artifact: { path: 'authority.json', sha256: references.authorityIdentity },
    },
    validator: {
      validatorId: references.validatorId,
      artifacts: [{ path: 'validator.mjs', sha256: references.validatorIdentity }],
    },
  };
}

/**
 * Derives every per-candidate activation role from what was measured (the check runs), what the
 * candidate committed (policy, mapping) and what the operator attested (the review record).
 * Nothing is copied from the base activation except the audit stratum table.
 * @throws {@link RelocationRefusal} `R4`-`R18` and `R21`.
 */
export function planRelocationActivation(
  sources: RelocationSources,
  runs: readonly CheckRun[],
  reviewInput: unknown,
  attestation: RelocationAttestation,
): RelocationPlan {
  const plan = planRelocationChecks(sources);
  const candidate = policyOf(sources.candidate.policyBytes, 'candidate trusted policy JSON');
  const policy = candidate.view;
  const identity = plan.candidateIdentity;
  const sha = sources.candidate.sha;
  const sha12 = sha.slice(0, 12);
  const review = parseOrThrow(AuditReview, reviewInput);
  assertReviewBinds(review, policy, sha, identity);
  const reviewReceipt = encode(review.evidence.receipt);
  const reviewIdentity = hashBytes(reviewReceipt);
  const lineage = ((
    source: RelocationBase,
  ): {
    strata: typeof AuditEvaluation.infer.strata;
    stratumOf: (id: string) => string | undefined;
  } => {
    if (source.kind === 'toolkit') {
      const { obligationStrata } = source;
      return { strata: source.strata, stratumOf: (id) => obligationStrata[id] };
    }
    const baseAuthority = parseOrThrow(
      BaseAuthorityView,
      parseJson(source.authorityBytes, 'base trusted authority JSON'),
    );
    return {
      strata: baseAuthority.audit.strata,
      stratumOf: (id) =>
        baseAuthority.audit.obligations.find(({ obligationId }) => obligationId === id)
          ?.riskStratum,
    };
  })(sources.base);
  const reviewedInputs = contentInputs(sources.candidate.reviewed);
  const currentInputs = contentInputs(
    sources.candidate.tree,
    new Map(reviewedInputs.map((input) => [input.path, input])),
  );
  const changes = contentChanges(reviewedInputs, currentInputs);
  const checkIds = policyCheckIds(policy);
  const reviewIds = policyReviewIds(policy);
  const receipts = checkIds.map((checkId) => {
    const run = runs.find((candidateRun) => candidateRun.checkId === checkId);
    if (run === undefined) throw new Error(`check run is missing for ${checkId}`);
    const planned = plan.checks.find((check) => check.checkId === checkId);
    if (planned === undefined) throw new Error(`check command is missing for ${checkId}`);
    return {
      observationId: `observation.${checkId}`,
      receipt: receiptOf(run, planned.skipChannel, sha12, identity, attestation),
    };
  });
  const reviewedIdentity = candidateIdentityOf(sources.candidate.reviewed);
  const reviewedSelection = sources.candidate.reviewed.selection;
  // Proof: forcing this refusal false read `revision` off a working selection that has none; the
  // working-selection negative observed `canonical JSON cannot serialize undefined` from the
  // obligation request instead of this named refusal.
  if (reviewedSelection.kind !== 'committed') {
    throw new Error(`reviewed snapshot is not a committed selection: ${reviewedSelection.kind}`);
  }
  const reviewedSourceBase = reviewedSelection.revision;
  const obligationRequest = {
    reviewed: {
      sourceBase: reviewedSourceBase,
      candidateIdentity: reviewedIdentity,
      inputs: { content: reviewedInputs, structural: [], semantic: [], topology: [] },
    },
    current: {
      sourceBase: sha,
      candidateIdentity: identity,
      inputs: { content: currentInputs, structural: [], semantic: [], topology: [] },
    },
    judgments: reviewIds.map((reviewId) => ({
      judgmentId: reviewId,
      kind: 'content',
      subjectId: `subject.${reviewId}`,
      bindings: {
        content: changes
          .filter((change) => change.change !== 'added')
          .map(({ inputId }) => ({ kind: 'content', inputId })),
        structural: [],
        semantic: [],
        topology: [],
      },
    })),
    policy: {
      policyId: policy.policyId,
      behaviorRules: changes.map(({ inputId }) => ({
        contentInputId: inputId,
        consumerChecks: checkIds,
        conformanceChecks: [],
        expandedReviewJudgments: reviewIds,
      })),
    },
    impactClassifications: changes.map((change) => ({
      classificationId: `classification.${change.inputId}`,
      contentInputId: change.inputId,
      reviewedSourceBase,
      currentSourceBase: sha,
      reviewedCandidateIdentity: reviewedIdentity,
      currentCandidateIdentity: identity,
      classification: 'behavior-changing',
      authority: { kind: 'reviewed', reviewIdentity },
      change: change.change,
      ...(change.change === 'added' ? { currentIdentity: change.current.blob } : {}),
      ...(change.change === 'changed'
        ? { reviewedIdentity: change.reviewed.blob, currentIdentity: change.current.blob }
        : {}),
      ...(change.change === 'removed' ? { reviewedIdentity: change.reviewed.blob } : {}),
    })),
    writerLabels: [],
    checks: checkIds.map((checkId) => ({
      observationId: `observation.${checkId}`,
      checkId,
      candidateIdentity: identity,
      status: 'passed',
    })),
    reviews: reviewIds.map((reviewId) => ({
      observationId: `observation.${reviewId}`,
      judgmentId: reviewId,
      candidateIdentity: identity,
      status: 'current',
    })),
  };
  const audit = {
    schemaVersion: 1,
    auditId: `audit.tool-wiki.bootstrap.${sha12}`,
    sourceBase: sha,
    candidateIdentity: identity,
    generation: 1,
    seed: `seed.tool-wiki.bootstrap.${sha12}`,
    coverage: 'exhaustive',
    strata: lineage.strata,
    obligations: reviewIds.map((reviewId) => {
      const riskStratum = lineage.stratumOf(reviewId);
      // Proof: replacing this refusal with `riskStratum ?? 'risk.public-admission'` invented a
      // stratum for a review neither the base activation nor the operator's strata file
      // stratified; the R21 negative received `Received function did not throw`.
      if (riskStratum === undefined) {
        refuse(
          'R21',
          sources.base.kind === 'base'
            ? `base authority has no obligation for review: ${reviewId}`
            : `audit strata name no stratum for review: ${reviewId}`,
        );
      }
      return {
        obligationId: reviewId,
        riskStratum,
        subject: review.evidence.protocolEvidence.subject,
      };
    }),
    mode: 'enforce',
    claimedCoverage: 'exhaustive',
    reviews: [review],
    corrections: [],
    closures: [],
    adjudications: [],
  };
  const authorityId = `authority.tool-wiki.bootstrap.${sha12}`;
  const authority = encode({
    schemaVersion: 1,
    authorityId,
    obligationRequest,
    checkReceipts: receipts,
    audit,
  });
  const evidence = encode({
    schemaVersion: 1,
    reportMode: 'enforce',
    obligations: policy.obligations.map(
      ({ obligationId, checkIds: checks, reviewIds: reviews }) => ({
        obligationId,
        checkIds: checks,
        reviewIds: reviews,
      }),
    ),
  });
  const ids = {
    authorityId,
    journalId: review.evidence.receipt.trust.journalId,
    ciBindingId: `binding.tool-wiki.bootstrap.ci.${sha12}`,
    localBindingId: `binding.tool-wiki.bootstrap.local-operator.${sha12}`,
    validatorId: `validator.tool-wiki.bootstrap.${sha12}`,
    receiptId: review.evidence.receipt.receiptId,
    trustScope:
      review.evidence.receipt.trust.scope === 'trusted-harness'
        ? ('trusted-harness' as const)
        : ('external-verifier' as const),
  };
  const references = {
    authorityId,
    journalId: ids.journalId,
    trustScope: ids.trustScope,
    validatorId: ids.validatorId,
    policyIdentity: hashBytes(sources.candidate.policyBytes),
    mappingIdentity: hashBytes(sources.candidate.mappingBytes),
    authorityIdentity: hashBytes(authority),
    validatorIdentity: sources.candidate.validatorIdentity,
    mappingPath: sources.candidate.mappingPath,
  };
  return {
    ids,
    roles: {
      policy: sources.candidate.policyBytes,
      mapping: sources.candidate.mappingBytes,
      evidence,
      authority,
      reviewReceipt,
      ciBinding: encode(bindingRecord('ci', ids.ciBindingId, references)),
      localBinding: encode(bindingRecord('local-operator', ids.localBindingId, references)),
    },
    identities: {
      policy: references.policyIdentity,
      mapping: references.mappingIdentity,
      reviewReceipt: reviewIdentity,
      validator: sources.candidate.validatorIdentity,
    },
    candidateIdentity: identity,
    changedValidator: sources.candidate.validatorIdentity !== sources.base.validatorIdentity,
    checkReceipts: receipts,
  };
}
