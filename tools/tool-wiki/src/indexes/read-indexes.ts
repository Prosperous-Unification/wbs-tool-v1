import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { parseOrThrow } from '@wbs/validation';
import type { PhrasingContent, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';
import { SKIP, visit } from 'unist-util-visit';

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

function decodeUtf8(
  path: string,
  bytes: Uint8Array,
  preserveBom: boolean,
  subject: string,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`selected ${subject} is not UTF-8 at ${path}: ${detail}`, { cause });
  }
}

function decodeMarkdown(path: string, bytes: Uint8Array): string {
  return decodeUtf8(path, bytes, false, 'Markdown');
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

/** Decodes an exact selected symlink blob while preserving a leading BOM as a path code point. */
export function symlinkTarget(path: string, bytes: CandidateBytes): string {
  const selected = bytes.get(path);
  if (selected === undefined) throw new Error(`selected symlink bytes absent: ${path}`);
  // Proof: stripping the BOM made the present-target CLI fail at `guide-link -> docs/guide.md`
  // and made the dangling-target CLI omit the leading U+FEFF from its required diagnostic.
  return decodeUtf8(path, selected, true, 'symlink target');
}

/**
 * Returns rendered explicit anchors and repository-convention Markdown heading slugs.
 *
 * Heading slugs use visible rendered text: lowercase Unicode letters/numbers, preserved `_` and
 * `-`, deleted punctuation, hyphenated whitespace and no edge hyphens. A collision appends the
 * lowest unused positive `-N` suffix to that heading's base slug.
 */
export function markdownAnchors(source: string): Set<string> {
  const syntax = fromMarkdown(source);
  const anchors = new Set<string>();
  const marker = headingMarker(source);
  const fragments: string[] = [];
  visit(syntax, (node) => {
    if (node.type === 'heading') {
      fragments.push(`<${marker}>${headingHtml(node.children)}</${marker}>`);
      return SKIP;
    }
    if (node.type === 'html') fragments.push(node.value);
    return undefined;
  });
  // Proof: collecting mdast headings directly made `## Details` inside `<template>` satisfy
  // the production CLI link and exit 0 (expected exit 1, received 0).
  readRenderedAnchors(fragments.join(''), marker, anchors);
  return anchors;
}

function escapeHtmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function headingHtml(children: readonly PhrasingContent[]): string {
  return children
    .map((child) => {
      // Proof: setting inline HTML to escaped text exposed inert `Draft` as heading text, so the
      // `#release-notes` production CLI link failed absent (expected exit 0, received 1).
      if (child.type === 'html') return toString(child, { includeHtml: true });
      // Proof: inserting `toString(..., { includeHtml: true })` as raw HTML let encoded angle
      // brackets plus split emphasis forge the private marker; the production CLI exited 0
      // (expected exit 1).
      if (child.type === 'text' || child.type === 'inlineCode') return escapeHtmlText(child.value);
      if (child.type === 'break') return '\n';
      if (child.type === 'image' || child.type === 'imageReference') {
        return escapeHtmlText(child.alt ?? '');
      }
      if ('children' in child) return headingHtml(child.children);
      return escapeHtmlText(toString(child, { includeHtml: false }));
    })
    .join('');
}

function headingMarker(source: string): string {
  let marker = 'wbs-index-heading';
  const foldedSource = source.toLocaleLowerCase('en-US');
  // Proof: case-sensitive collision detection let raw `<WBS-INDEX-HEADING>Forged` source be
  // normalized by HTML parsing into the internal marker and exit 0 (expected exit 1).
  while (foldedSource.includes(marker)) marker += '-x';
  return marker;
}

function headingBase(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function renderedText(node: DefaultTreeAdapterTypes.ChildNode): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  if (!('tagName' in node) || ['script', 'style', 'template'].includes(node.tagName)) return '';
  return node.childNodes.map((child) => renderedText(child)).join('');
}

function readRenderedAnchors(source: string, marker: string, anchors: Set<string>): void {
  const usedHeadingSlugs = new Set<string>();
  // Proof: restoring the raw `<a>` regex made the comment, script, and inert-template CLI
  // regressions each exit 0 (all expected exit 1, all received 0).
  const pending: DefaultTreeAdapterTypes.ChildNode[] = [
    ...parseFragment(source).childNodes,
  ].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || !('attrs' in node)) continue;
    const id = node.attrs.find(({ name }) => name === 'id');
    // Proof: limiting IDs to `<a>` elements made the rendered `<section id="details">` CLI
    // fail with `Markdown anchor absent ... #details` (expected exit 0, received 1).
    if (id !== undefined) anchors.add(id.value);
    if (node.tagName === 'a') {
      const name = node.attrs.find((attribute) => attribute.name === 'name');
      if (name !== undefined) anchors.add(name.value);
    }
    if (node.tagName === marker) {
      const base = headingBase(renderedText(node));
      let slug = base;
      let suffix = 0;
      // Proof: counting duplicates per base made `A`, `A`, `A-1` omit `a-1-1`, so its
      // production CLI link failed absent (expected exit 0, received 1).
      while (usedHeadingSlugs.has(slug)) {
        suffix += 1;
        slug = `${base}-${String(suffix)}`;
      }
      usedHeadingSlugs.add(slug);
      anchors.add(slug);
    }
    // Proof: also enqueuing a template node's `content.childNodes` made inert
    // `<a id="details">` content satisfy the production CLI link and exit 0
    // (expected exit 1, received 0).
    pending.push(...[...node.childNodes].reverse());
  }
}
