import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import type { RelationshipRequest } from '../contracts/records';
import { hashCanonical } from '../evidence/content-manifest';
import type { CandidateSnapshot } from '../inventory/read-candidate';
import { extractNxRelationships } from './nx';
import { extractTypeScriptRelationships } from './typescript';

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

function invokeGit(repository: string, argv: string[], stdin?: Uint8Array): Uint8Array {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stdin,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const detail = invocation.stderr.toString('utf8').trim();
    throw new Error(
      `relationship candidate blob read failed: ${detail.length === 0 ? `git exited ${String(invocation.exitCode)}` : detail}`,
    );
  }
  return invocation.stdout;
}

function readBlobs(repository: string, candidate: CandidateSnapshot): Map<string, Uint8Array> {
  const requested = candidate.entries.filter((entry) => entry.mode !== '160000');
  const input = Buffer.from(`${requested.map((entry) => entry.blob).join('\n')}\n`, 'utf8');
  const output = Buffer.from(invokeGit(repository, ['cat-file', '--batch'], input));
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  for (const entry of requested) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0)
      throw new Error(`relationship candidate blob output malformed for ${entry.path}`);
    const header = output.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) blob ([0-9]+)$/.exec(header);
    if (match?.[1] !== entry.blob) {
      throw new Error(`relationship candidate blob output malformed for ${entry.path}: ${header}`);
    }
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`relationship candidate blob length malformed for ${entry.path}`);
    }
    const start = newline + 1;
    const end = start + length;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`relationship candidate blob bytes truncated for ${entry.path}`);
    }
    blobs.set(entry.path, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length)
    throw new Error('relationship candidate blob output has trailing bytes');
  return blobs;
}

function assertContained(root: string, path: string, context: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith('../')) {
    throw new Error(`${context} escapes the materialized candidate`);
  }
}

function materializeCandidate(repository: string, candidate: CandidateSnapshot): string {
  if (candidate.untracked.length > 0) {
    throw new Error(
      `relationship extraction cannot resolve untracked diagnostic paths: ${candidate.untracked.join(', ')}`,
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), 'tool-wiki-candidate-'));
  const blobs = readBlobs(repository, candidate);
  for (const entry of candidate.entries) {
    const destination = resolve(workspace, entry.path);
    assertContained(workspace, destination, `candidate path ${entry.path}`);
    if (entry.mode === '160000') {
      mkdirSync(destination, { recursive: true });
      continue;
    }
    const bytes = blobs.get(entry.path);
    if (bytes === undefined)
      throw new Error(`relationship candidate blob missing for ${entry.path}`);
    mkdirSync(dirname(destination), { recursive: true });
    if (entry.mode === '120000') {
      let target: string;
      try {
        target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `relationship candidate symlink target malformed at ${entry.path}: ${detail}`,
          {
            cause,
          },
        );
      }
      assertContained(
        workspace,
        resolve(dirname(destination), target),
        `candidate symlink ${entry.path}`,
      );
      symlinkSync(target, destination);
      continue;
    }
    writeFileSync(destination, bytes);
    if (entry.mode === '100755') chmodSync(destination, 0o755);
  }
  const installedModules = dirname(
    dirname(Bun.resolveSync('typescript/package.json', import.meta.dir)),
  );
  const modulesPath = join(workspace, 'node_modules');
  if (!candidate.entries.some((entry) => entry.path === 'node_modules')) {
    symlinkSync(installedModules, modulesPath, 'dir');
  }
  return workspace;
}

function relationshipInput(inputId: string, selectors: unknown): { inputId: string; blob: string } {
  return { inputId, blob: hashCanonical(selectors) };
}

function selectorIdentities(selectors: readonly { identity: string }[]): string[] {
  return selectors.map((selector) => selector.identity).sort(compareText);
}

/** Extracts version-bound structural relationships from one frozen candidate snapshot. */
export function extractRelationships(
  repository: string,
  candidate: CandidateSnapshot,
  request: RelationshipRequest,
): object {
  const workspace = materializeCandidate(repository, candidate);
  try {
    const typescript = extractTypeScriptRelationships(workspace, request.typescript);
    const nx = extractNxRelationships(workspace);
    const extractors = [nx.extractor, typescript.extractor].sort((left, right) =>
      compareText(left.extractorId, right.extractorId),
    );
    const relationshipInputs = [
      relationshipInput('nx.dependencies', selectorIdentities(nx.relationships.dependencies)),
      relationshipInput('nx.projects', selectorIdentities(nx.relationships.projects)),
      relationshipInput('nx.targets', selectorIdentities(nx.relationships.targets)),
      relationshipInput('typescript.imports', selectorIdentities(typescript.relationships.imports)),
      relationshipInput(
        'typescript.public-declarations',
        selectorIdentities(typescript.relationships.publicDeclarations),
      ),
      relationshipInput(
        'typescript.reverse-edges',
        selectorIdentities(typescript.relationships.reverseEdges),
      ),
    ].sort((left, right) => compareText(left.inputId, right.inputId));
    return {
      schemaVersion: 1,
      selection: candidate.selection,
      extractors,
      manifestInputs: { relationshipInputs, extractors },
      typescript: typescript.relationships,
      nx: nx.relationships,
    };
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
}
