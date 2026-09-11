import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { parseOrThrow } from '@wbs/validation';
import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';

import { IndexMetadata, type IndexMetadata as IndexMetadataRecord } from '../contracts';
import { hashCanonical } from '../evidence/content-manifest';
import type { CandidateSnapshot } from '../inventory/read-candidate';

const MetadataPattern = /^<!--\s*wbs-index\s+([\s\S]*?)-->$/;

export interface MarkdownLink {
  destination: string;
}

export interface ReadIndex {
  indexPath: string;
  directory: string;
  metadata: IndexMetadataRecord;
  identity: string;
  links: MarkdownLink[];
}

export type CandidateBytes = ReadonlyMap<string, Uint8Array>;

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function readBlob(repository: string, path: string, blob: string): Uint8Array {
  // Proof: reading `${repository}/${path}` instead made the immutable-candidate test parse the
  // dirty host README and refuse its version 99 metadata; the selected committed blob is stable.
  const invocation = Bun.spawnSync(['git', '-C', repository, 'cat-file', 'blob', blob], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    // Proof: returning the failed invocation's empty stdout moved the unreadable-index CLI
    // failure to `selected candidate contains no wbs indexes`, hiding the unreadable blob.
    throw new Error(
      `cannot read selected index ${path}: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail}`,
    );
  }
  return invocation.stdout;
}

function decodeMarkdown(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`selected Markdown is not UTF-8 at ${path}: ${detail}`, { cause });
  }
}

function parseMetadata(indexPath: string, syntax: Root): IndexMetadataRecord | undefined {
  const comments: string[] = [];
  visit(syntax, 'html', (html) => {
    if (html.value.includes('wbs-index')) comments.push(html.value.trim());
  });
  if (comments.length === 0) return undefined;
  const matches = comments.map((comment) => MetadataPattern.exec(comment));
  // Proof: accepting metadata from the Markdown source instead made the fenced-metadata CLI
  // exit 0 with `module.example` even though the envelope was only a code example.
  if (matches.some((match) => match === null)) {
    throw new Error(`index metadata malformed at ${indexPath}: invalid metadata block`);
  }
  if (matches.length !== 1) {
    throw new Error(`index metadata malformed at ${indexPath}: expected exactly one block`);
  }
  let input: unknown;
  try {
    const match = matches[0];
    if (match === null) throw new Error('invalid metadata block');
    input = JSON.parse(match[1]) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`index metadata malformed at ${indexPath}: ${detail}`, { cause });
  }
  try {
    return parseOrThrow(IndexMetadata, input);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`index metadata malformed at ${indexPath}: ${detail}`, { cause });
  }
}

function readLinks(indexPath: string, syntax: Root): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const definitions = new Map<string, string>();
  visit(syntax, 'definition', (definition) => {
    if (!definitions.has(definition.identifier)) {
      definitions.set(definition.identifier, definition.url);
    }
  });
  visit(syntax, 'link', (link) => {
    links.push({ destination: link.url });
  });
  visit(syntax, 'linkReference', (reference) => {
    const destination = definitions.get(reference.identifier);
    // mdast emits a linkReference only when its definition resolves; keep that parser boundary
    // explicit so a future parser-contract change fails closed.
    if (destination === undefined) {
      throw new Error(`Markdown reference target absent in ${indexPath}: ${reference.identifier}`);
    }
    // Proof: omitting resolved references made the absent-reference-target production CLI exit 0
    // without checking `docs/absent.md` (expected exit 1, received 0).
    links.push({ destination });
  });
  return links;
}

/** Reads index envelopes and Markdown navigation from the immutable candidate blobs only. */
export function readIndexes(
  repository: string,
  candidate: CandidateSnapshot,
): { indexes: ReadIndex[]; bytes: CandidateBytes } {
  if (candidate.untracked.length > 0) {
    throw new Error(
      `index checks cannot resolve untracked diagnostic paths: ${candidate.untracked.join(', ')}`,
    );
  }
  const bytes = new Map<string, Uint8Array>();
  const indexes: ReadIndex[] = [];
  for (const entry of candidate.entries) {
    if (entry.mode === '160000') continue;
    const selectedBytes = readBlob(repository, entry.path, entry.blob);
    bytes.set(entry.path, selectedBytes);
    if (posix.basename(entry.path) !== 'README.md' || entry.mode === '120000') continue;
    const source = decodeMarkdown(entry.path, selectedBytes);
    const syntax = fromMarkdown(source);
    const metadata = parseMetadata(entry.path, syntax);
    if (metadata === undefined) continue;
    indexes.push({
      indexPath: entry.path,
      directory: posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path),
      metadata,
      identity: hashCanonical({ schemaVersion: 1, indexPath: entry.path, metadata }),
      links: readLinks(entry.path, syntax),
    });
  }
  indexes.sort((left, right) => compareText(left.indexPath, right.indexPath));
  return { indexes, bytes };
}

export function markdownText(path: string, bytes: CandidateBytes): string {
  const selected = bytes.get(path);
  if (selected === undefined) throw new Error(`selected Markdown bytes absent: ${path}`);
  return decodeMarkdown(path, selected);
}

export function markdownAnchors(source: string): Set<string> {
  const syntax = fromMarkdown(source);
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  visit(syntax, 'heading', (heading) => {
    const base = toString(heading)
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  });
  visit(syntax, 'html', (html) => {
    // Proof: scanning the Markdown source made a fenced `<a id="details">` example satisfy the
    // production CLI's `docs/guide.md#details` link (expected exit 1, received 0).
    for (const match of html.value.matchAll(
      /<a\s+(?:[^>]*?\s)?(?:id|name)=["']([^"']+)["'][^>]*>/gi,
    )) {
      anchors.add(match[1]);
    }
  });
  return anchors;
}
