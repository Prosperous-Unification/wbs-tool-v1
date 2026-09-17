import { isAbsolute, normalize } from 'node:path';

const Session = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const Group = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function containsControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

function containsUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    }
    // Proof: accepting this identity made distinct lone surrogates compare through identical
    // UTF-8 replacement bytes; the production claim-boundary test lost its exact refusal.
    return true;
  }
  return false;
}

/** Refuses a session identity that cannot be persisted as one authority owner. */
export function assertAuthoritySessionId(sessionId: string): void {
  if (!Session.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

/** Refuses a worktree identity that is not already absolute and lexically canonical. */
export function assertAuthorityWorktreePath(worktreePath: string): void {
  if (
    !isAbsolute(worktreePath) ||
    normalize(worktreePath) !== worktreePath ||
    containsControl(worktreePath) ||
    containsUnpairedSurrogate(worktreePath) ||
    worktreePath.includes('\\')
  ) {
    throw new Error(`invalid canonical worktree path: ${worktreePath}`);
  }
}

/** Refuses a repository-relative path identity that would require normalization. */
export function assertAuthorityClaimPath(path: string): void {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    containsControl(path) ||
    containsUnpairedSurrogate(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid canonical claim path: ${path}`);
  }
}

/** Refuses a conflict group that is not a finite authority identity. */
export function assertAuthorityConflictGroup(identity: string): void {
  if (!Group.test(identity)) throw new Error(`invalid conflict group: ${identity}`);
}

/** Refuses a runtime path access outside the closed read/write domain. */
export function assertAuthorityPathAccess(access: string): asserts access is 'read' | 'write' {
  if (access !== 'read' && access !== 'write') {
    throw new Error(`invalid path access: ${access}`);
  }
}
