import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { parseOrThrow } from '@wbs/validation';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';

import { IndexMetadata, type IndexMetadata as IndexMetadataRecord } from '../contracts';
import { hashCanonical } from '../evidence/content-manifest';
import type { CandidateSnapshot } from '../inventory/read-candidate';

const MetadataPattern = /<!--\s*wbs-index\s+([\s\S]*?)-->/g;

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
    // Proof: returning the failed invocation's empty stdout made the unreadable-index CLI exit 0
    // with `indexes: []` and no debt (expected exit 1, received 0).
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

function parseMetadata(indexPath: string, source: string): IndexMetadataRecord | undefined {
  const matches = [...source.matchAll(MetadataPattern)];
  if (matches.length === 0) {
    if (source.includes('wbs-index')) {
      throw new Error(`index metadata malformed at ${indexPath}: invalid metadata block`);
    }
    return undefined;
  }
  if (matches.length !== 1) {
    throw new Error(`index metadata malformed at ${indexPath}: expected exactly one block`);
  }
  let input: unknown;
  try {
    input = JSON.parse(matches[0][1]) as unknown;
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

function readLinks(source: string): MarkdownLink[] {
  const syntax = fromMarkdown(source);
  const links: MarkdownLink[] = [];
  visit(syntax, 'link', (link) => {
    links.push({ destination: link.url });
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
    const metadata = parseMetadata(entry.path, source);
    if (metadata === undefined) continue;
    indexes.push({
      indexPath: entry.path,
      directory: posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path),
      metadata,
      identity: hashCanonical({ schemaVersion: 1, indexPath: entry.path, metadata }),
      links: readLinks(source),
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
  for (const match of source.matchAll(/<a\s+(?:[^>]*?\s)?(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}
