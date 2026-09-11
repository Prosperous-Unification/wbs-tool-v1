import { posix } from 'node:path';

import { parseOrThrow, type } from '@wbs/validation';

import type {
  CandidateEntry,
  CandidateSelection,
  CandidateSnapshot,
} from '../inventory/read-candidate';

const Sha1 = type(/^[0-9a-f]{40}$/);
const Sha256 = type(/^[0-9a-f]{64}$/);
const StableId = type(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const TrustedMigrationId = 'root-knowledge.v1';
const TrustedSourceCount = 3;
const TrustedBlockCount = 58;
const TrustedAuthorityDigest = '98c30c15ea93469e36248b5dfc6fcef7e8ef420faca7712bb187b8e11db45460';
const HeadingLocator = type({ kind: "'heading'" }).onUndeclaredKey('reject');
const BlockLocator = type({ kind: "'block'", ordinal: 'number.integer>=1' }).onUndeclaredKey(
  'reject',
);
const RootSourceBlock = type({
  sourceId: StableId,
  locator: HeadingLocator.or(BlockLocator),
  sha256: Sha256,
  destinationAnchor: StableId,
}).onUndeclaredKey('reject');
const RootSource = type({
  sourcePath: 'string>=1',
  sourceRevision: Sha1,
  sourceBlob: Sha1,
  sourceHeading: 'string>=1',
  destinationPath: 'string>=1',
  blocks: RootSourceBlock.array(),
}).onUndeclaredKey('reject');
const RootMigration = type({
  // Proof: a version-2 map made the production CLI exit 1 with `root migration schema invalid`
  // in `refuses malformed versions, path escape and symlink destinations`.
  schemaVersion: '1',
  migrationId: StableId,
  sources: RootSource.array(),
}).onUndeclaredKey('reject');

type RootMigration = typeof RootMigration.infer;
type RootSource = typeof RootSource.infer;
const Utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface RootMigrationReport {
  schemaVersion: 1;
  migrationId: string;
  selection: CandidateSelection;
  sourceCount: number;
  blockCount: number;
  caps: { agents: 120; llmReadme: 150 };
}

function invokeGit(repository: string, argv: string[], context: string): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    // Proof: a pinned all-zero historical revision made the production CLI exit 1 with
    // `cannot resolve historical root source AGENTS.md`.
    throw new Error(
      `${context}: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail}`,
    );
  }
  return invocation.stdout;
}

function decode(bytes: Uint8Array, context: string): string {
  try {
    return Utf8.decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: a selected catalogue containing byte 0xff made the production CLI exit 1 with
    // `cannot decode selected ...: non-UTF-8 content`.
    throw new Error(`${context}: non-UTF-8 content: ${detail}`, { cause });
  }
}

function hash(source: string): string {
  return new Bun.CryptoHasher('sha256').update(source).digest('hex');
}

function assertCandidatePath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    path.length === 0 ||
    posix.isAbsolute(path) ||
    normalized !== path ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('\0')
  ) {
    // Proof: `../escape.md` made the production CLI exit 1 with
    // `root migration path escapes candidate: ../escape.md`.
    throw new Error(`root migration path escapes candidate: ${path}`);
  }
}

function readSelectedBlob(
  repository: string,
  entries: ReadonlyMap<string, CandidateEntry>,
  path: string,
  absentMessage: string,
): string {
  assertCandidatePath(path);
  const entry = entries.get(path);
  // Proof: deleting the mapped catalogue made the production CLI exit 1 with
  // `mapped destination absent: docs/findings/checks-that-cannot-fail.md`.
  if (entry === undefined) throw new Error(absentMessage);
  // Proof: replacing that catalogue with a selected symlink made the production CLI exit 1
  // with `mapped destination is not a regular selected blob`.
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new Error(`mapped destination is not a regular selected blob: ${path}`);
  }
  return decode(
    invokeGit(repository, ['cat-file', 'blob', entry.blob], `cannot read selected ${path}`),
    `cannot decode selected ${path}`,
  );
}

function readHistoricalSource(repository: string, source: RootSource): string {
  assertCandidatePath(source.sourcePath);
  const observedBlob = decode(
    invokeGit(
      repository,
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${source.sourceRevision}:${source.sourcePath}`,
      ],
      `cannot resolve historical root source ${source.sourcePath}`,
    ),
    `cannot decode historical source identity ${source.sourcePath}`,
  ).trim();
  if (observedBlob !== source.sourceBlob) {
    // Proof: substituting 40 zeroes for the pinned blob made the production CLI exit 1 with
    // `historical source blob mismatch: AGENTS.md`.
    throw new Error(
      `historical source blob mismatch: ${source.sourcePath} expected ${source.sourceBlob} received ${observedBlob}`,
    );
  }
  return decode(
    invokeGit(
      repository,
      ['cat-file', 'blob', source.sourceBlob],
      `cannot read historical root source ${source.sourcePath}`,
    ),
    `cannot decode historical root source ${source.sourcePath}`,
  );
}

function sectionBlocks(source: string, heading: string): { heading: string; blocks: string[] } {
  const headingText = `## ${heading}`;
  const lines = source.split('\n');
  const start = lines.indexOf(headingText);
  // Proof: selecting `Missing catalogue` made the production CLI exit 1 with
  // `historical source heading absent: Missing catalogue`.
  if (start < 0) throw new Error(`historical source heading absent: ${heading}`);
  const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  return { heading: headingText, blocks: body.length === 0 ? [] : body.split(/\n\n+/) };
}

function count(source: string, needle: string): number {
  let occurrences = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    occurrences += 1;
    offset += needle.length;
  }
  return occurrences;
}

interface DestinationBlock {
  anchor: string;
  payload: string;
}

function destinationBlocks(path: string, source: string): ReadonlyMap<string, DestinationBlock> {
  const header = /<a id="([a-z][a-z0-9._-]*)"><\/a>\n<!-- root-source:([a-z][a-z0-9._-]*) -->\n\n/g;
  const headers = [...source.matchAll(header)];
  const structuralMarkers = new Set(headers.map((match) => match.index + match[0].indexOf('<!--')));
  for (const marker of source.matchAll(/<!-- root-source:([^ ]+) -->/g)) {
    // Proof: moving `r5-catalogue-001` away from its marker and appending
    // `r5.catalogue.orphan` without an owning map entry separately made the production CLI exit 1
    // with `unexpected root source marker` in their named tests.
    if (!structuralMarkers.has(marker.index))
      throw new Error(`unexpected root source marker: ${path}#${marker[1]}`);
  }
  const blocks = new Map<string, DestinationBlock>();
  for (const [index, match] of headers.entries()) {
    const anchor = match[1];
    const sourceId = match[2];
    const start = match.index + match[0].length;
    const next = headers.at(index + 1);
    let end = next === undefined ? source.length : next.index;
    if (next === undefined && source.endsWith('\n')) end -= 1;
    if (next !== undefined && source.slice(0, end).endsWith('\n\n')) end -= 2;
    const payload = source.slice(start, end);
    if (blocks.has(sourceId)) throw new Error(`duplicate root source marker: ${path}#${sourceId}`);
    blocks.set(sourceId, { anchor, payload });
  }
  return blocks;
}

function validateSource(
  repository: string,
  entries: ReadonlyMap<string, CandidateEntry>,
  source: RootSource,
  sourceIds: Set<string>,
  destinationKeys: Set<string>,
  parsedDestinations: Map<string, ReadonlyMap<string, DestinationBlock>>,
): number {
  assertCandidatePath(source.destinationPath);
  const historical = sectionBlocks(readHistoricalSource(repository, source), source.sourceHeading);
  const destination = readSelectedBlob(
    repository,
    entries,
    source.destinationPath,
    `mapped destination absent: ${source.destinationPath}`,
  );
  const blocks =
    parsedDestinations.get(source.destinationPath) ??
    destinationBlocks(source.destinationPath, destination);
  parsedDestinations.set(source.destinationPath, blocks);
  const locators = new Set<string>();
  for (const block of source.blocks) {
    // Proof: duplicating `agents-r5.heading` made the production CLI exit 1 with
    // `duplicate root source id: agents-r5.heading`.
    if (sourceIds.has(block.sourceId))
      throw new Error(`duplicate root source id: ${block.sourceId}`);
    sourceIds.add(block.sourceId);
    const destinationKey = `${source.destinationPath}#${block.destinationAnchor}`;
    // Proof: mapping two source blocks to the same path and anchor made the production CLI exit 1
    // with `duplicate root destination: docs/findings/checks-that-cannot-fail.md#agents-r5-heading`.
    if (destinationKeys.has(destinationKey))
      throw new Error(`duplicate root destination: ${destinationKey}`);
    destinationKeys.add(destinationKey);
    const locatorKey =
      block.locator.kind === 'heading' ? 'heading' : `block:${String(block.locator.ordinal)}`;
    // Proof: assigning two blocks the heading locator made the production CLI exit 1 with
    // `duplicate historical source locator in AGENTS.md#Checks that cannot fail: heading`.
    if (locators.has(locatorKey))
      throw new Error(
        `duplicate historical source locator in ${source.sourcePath}#${source.sourceHeading}: ${locatorKey}`,
      );
    locators.add(locatorKey);
    const payload =
      block.locator.kind === 'heading'
        ? historical.heading
        : historical.blocks.at(block.locator.ordinal - 1);
    // Proof: selecting block 2 from a one-block source made the production CLI exit 1 with
    // `historical source locator absent: agents-r5.001`.
    if (payload === undefined)
      throw new Error(`historical source locator absent: ${block.sourceId}`);
    // Proof: replacing a pinned paragraph digest with zeroes made the production CLI exit 1 with
    // `historical source content digest mismatch: agents-r5.001`.
    if (hash(payload) !== block.sha256)
      throw new Error(`historical source content digest mismatch: ${block.sourceId}`);
    const destinationBlock = blocks.get(block.sourceId);
    if (destinationBlock === undefined)
      throw new Error(
        `mapped destination block absent: ${source.destinationPath}#${block.destinationAnchor}`,
      );
    // Proof: appending text to `r5.catalogue.001` made `refuses appended payload text` exit 1
    // with `mapped destination block mismatch` instead of accepting its exact payload prefix.
    if (destinationBlock.anchor !== block.destinationAnchor || destinationBlock.payload !== payload)
      throw new Error(
        `mapped destination block mismatch: ${source.destinationPath}#${block.destinationAnchor}`,
      );
  }
  // Proof: deleting the heading mapping made the production CLI exit 1 with
  // `root source heading is not mapped: AGENTS.md#Checks that cannot fail`.
  if (!locators.has('heading'))
    throw new Error(
      `root source heading is not mapped: ${source.sourcePath}#${source.sourceHeading}`,
    );
  for (let ordinal = 1; ordinal <= historical.blocks.length; ordinal += 1) {
    // Proof: deleting the only paragraph mapping made the production CLI exit 1 with
    // `root source block is not mapped: AGENTS.md#Checks that cannot fail block 1`.
    if (!locators.has(`block:${String(ordinal)}`))
      throw new Error(
        `root source block is not mapped: ${source.sourcePath}#${source.sourceHeading} block ${String(ordinal)}`,
      );
  }
  return source.blocks.length;
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/[ _]+/g, '-')
    .replace(/-+/g, '-');
}

function exactPath(
  sourcePath: string,
  requested: string,
  entries: ReadonlyMap<string, CandidateEntry>,
): string {
  if (entries.has(requested)) return requested;
  const folded = requested.toLocaleLowerCase('en-US');
  const caseMatches = [...entries.keys()].filter(
    (path) => path.toLocaleLowerCase('en-US') === folded,
  );
  // Proof: changing only the link's path case made the production CLI exit 1 with
  // `Markdown path case mismatch in LLM_README.md`.
  if (caseMatches.length === 1)
    throw new Error(
      `Markdown path case mismatch in ${sourcePath}: ${requested} -> ${caseMatches[0]}`,
    );
  // Proof: linking to `docs/findings/absent.md` made the production CLI exit 1 with
  // `Markdown path absent in LLM_README.md`.
  throw new Error(`Markdown path absent in ${sourcePath}: ${requested}`);
}

function validateMarkdownLinks(
  sourcePath: string,
  source: string,
  entries: ReadonlyMap<string, CandidateEntry>,
  repository: string,
): void {
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = match.at(1);
    if (destination === undefined || /^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;
    const parts = destination.split('#', 2);
    const rawPath = parts.at(0);
    const anchor = parts.at(1);
    if (rawPath === undefined) continue;
    const requested =
      rawPath.length === 0
        ? sourcePath
        : posix.normalize(posix.join(posix.dirname(sourcePath), rawPath));
    assertCandidatePath(requested);
    const path = exactPath(sourcePath, requested, entries);
    if (anchor === undefined || anchor.length === 0) continue;
    const target = readSelectedBlob(
      repository,
      entries,
      path,
      `Markdown path absent in ${sourcePath}: ${path}`,
    );
    const explicitCount = count(target, `<a id="${anchor}"></a>`);
    const headingCount = target
      .split('\n')
      .filter(
        (line) => /^#{1,6} /.test(line) && headingAnchor(line.replace(/^#{1,6} /, '')) === anchor,
      ).length;
    // Proof: linking the router to `#absent` and adding the fragment-only `#absent-incident`
    // separately made the production CLI exit 1 with `Markdown anchor must occur once in
    // LLM_README.md`, resolving the latter against LLM_README.md itself.
    if (explicitCount + headingCount !== 1)
      throw new Error(`Markdown anchor must occur once in ${sourcePath}: ${path}#${anchor}`);
  }
}

/** Verifies the reproducible root-knowledge move against one explicitly selected candidate. */
export function checkRootMigration(
  repository: string,
  candidate: CandidateSnapshot,
  mapPath: string,
): RootMigrationReport {
  const entries = new Map(candidate.entries.map((entry) => [entry.path, entry]));
  const mapSource = readSelectedBlob(
    repository,
    entries,
    mapPath,
    `root migration map absent: ${mapPath}`,
  );
  let input: unknown;
  try {
    input = JSON.parse(mapSource);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // Proof: a map containing only `{` made the production CLI exit 1 with
    // `root migration JSON malformed`.
    throw new Error(`root migration JSON malformed: ${detail}`, { cause });
  }
  let migration: RootMigration;
  try {
    migration = parseOrThrow(RootMigration, input);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`root migration schema invalid: ${detail}`, { cause });
  }
  const sourceIds = new Set<string>();
  const destinationKeys = new Set<string>();
  const sourceKeys = new Set<string>();
  const parsedDestinations = new Map<string, ReadonlyMap<string, DestinationBlock>>();
  let blockCount = 0;
  for (const source of migration.sources) {
    const sourceKey = `${source.sourceRevision}:${source.sourceBlob}:${source.sourcePath}#${source.sourceHeading}`;
    // Proof: duplicating a complete source entry made the production CLI exit 1 with
    // `duplicate root source entry` before reusing its mappings.
    if (sourceKeys.has(sourceKey)) throw new Error(`duplicate root source entry: ${sourceKey}`);
    sourceKeys.add(sourceKey);
    blockCount += validateSource(
      repository,
      entries,
      source,
      sourceIds,
      destinationKeys,
      parsedDestinations,
    );
  }
  for (const [path, blocks] of parsedDestinations) {
    for (const sourceId of blocks.keys()) {
      // Proof: appending a structurally valid `r5.catalogue.orphan` block made `refuses orphan
      // source markers` exit 1 with `unexpected root source marker`.
      if (!sourceIds.has(sourceId))
        throw new Error(`unexpected root source marker: ${path}#${sourceId}`);
    }
  }
  const authorityDigest = hash(JSON.stringify(migration.sources));
  // Proof: `sources: []` made `refuses a candidate map that omits the trusted historical
  // authority` exit 1 with `root migration authority mismatch`; replacing the sources with HEAD
  // `AGENTS.md#Migrations` made its separately named test fail with the same refusal.
  if (
    migration.migrationId !== TrustedMigrationId ||
    migration.sources.length !== TrustedSourceCount ||
    blockCount !== TrustedBlockCount ||
    authorityDigest !== TrustedAuthorityDigest
  ) {
    throw new Error(`root migration authority mismatch: ${authorityDigest}`);
  }
  const agents = readSelectedBlob(
    repository,
    entries,
    'AGENTS.md',
    'required root file absent: AGENTS.md',
  );
  const llmReadme = readSelectedBlob(
    repository,
    entries,
    'LLM_README.md',
    'required root file absent: LLM_README.md',
  );
  const agentsLines = lineCount(agents);
  // Proof: injecting exactly 121 lines made the production CLI exit 1 with
  // `AGENTS.md exceeds 120 lines: 121`.
  if (agentsLines > 120) throw new Error(`AGENTS.md exceeds 120 lines: ${String(agentsLines)}`);
  const llmLines = lineCount(llmReadme);
  // Proof: injecting exactly 151 lines made the production CLI exit 1 with
  // `LLM_README.md exceeds 150 lines: 151`.
  if (llmLines > 150) throw new Error(`LLM_README.md exceeds 150 lines: ${String(llmLines)}`);
  // Proof: restoring the incident heading in AGENTS made the production CLI exit 1 with
  // `AGENTS.md retains migrated incident catalogue`.
  if (/^## Checks that cannot fail$/m.test(agents))
    throw new Error('AGENTS.md retains migrated incident catalogue');
  // Proof: restoring `## Open findings` in the router made the production CLI exit 1 with
  // `LLM_README.md retains migrated mutable findings`.
  if (/^## (?:Landmines|Open findings)$/m.test(llmReadme))
    throw new Error('LLM_README.md retains migrated mutable findings');
  const markdownPaths = new Set([
    'AGENTS.md',
    'LLM_README.md',
    ...migration.sources.map(({ destinationPath }) => destinationPath),
  ]);
  for (const path of markdownPaths) {
    validateMarkdownLinks(
      path,
      readSelectedBlob(repository, entries, path, `required mapped Markdown absent: ${path}`),
      entries,
      repository,
    );
  }
  return {
    schemaVersion: 1,
    migrationId: migration.migrationId,
    selection: candidate.selection,
    sourceCount: migration.sources.length,
    blockCount,
    caps: { agents: 120, llmReadme: 150 },
  };
}
