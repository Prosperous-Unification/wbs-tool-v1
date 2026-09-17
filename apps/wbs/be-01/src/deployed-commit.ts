import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The commit the checkout this process is running from sits at.
 *
 * Dev deploys are a `git reset --hard` into a bind-mounted checkout whose
 * watchers (`bun --watch`, Vite) pick the change up with no restart
 * (`tools/tool-devsync/src/sync.ts`). That is the whole reason this reads the
 * refs from disk on every call instead of capturing a value at startup: the
 * deploy that most needs reporting — a docs or config commit that touches no
 * watched module — is exactly the one that never restarts this process, so a
 * commit read once at boot would report the previous deploy forever.
 *
 * What it reports is a precise thing and worth not overstating: **the commit
 * the source tree on disk is at**, not "the commit being served". Those differ
 * for the window between a `RESTART_PATHS` change landing and the restart that
 * applies it — which is why `sync.ts` restarts rather than trusting the
 * watchers, and why the poller reads this only to answer "did the reset land".
 *
 * A prod container has no `.git` (it serves a built image), so this answers
 * `null` there. Null means "this deployment cannot tell you", never "no deploy
 * has happened" — the caller has to treat the two as different, and the poller
 * does.
 */

/** A full object name. Abbreviated refs are never written into `HEAD`. */
const SHA = /^[0-9a-f]{40}$/;

/** How far up the tree to look before concluding there is no repository. */
const MAX_DEPTH = 64;

/**
 * The `.git` directory for `startDir`, or null.
 *
 * Handles `.git` being a *file* — that is what a worktree or a submodule has,
 * and this repo is developed in worktrees, so treating a `.git` file as "no
 * repository" would report null on precisely the checkouts a developer uses.
 */
function findGitDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = readFileSync(candidate, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match?.[1]) return null;
      const target = match[1].trim();
      return isAbsolute(target) ? target : resolve(dir, target);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** A ref's object name from its loose file, then from `packed-refs`. */
function resolveRef(gitDir: string, ref: string): string | null {
  const loose = join(gitDir, ref);
  if (existsSync(loose)) {
    const sha = readFileSync(loose, 'utf8').trim();
    return SHA.test(sha) ? sha : null;
  }
  // `git pack-refs` (which `git gc` runs on its own schedule) moves loose refs
  // into one file. A reader that only knows about loose refs works for weeks
  // and then reports null on a morning nobody touched the deploy.
  const packed = join(gitDir, 'packed-refs');
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, 'utf8').split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/**
 * The object name `HEAD` points at, or null if it cannot be read.
 *
 * Every failure answers null rather than throwing: this is called from the
 * health endpoint, and a 500 there is indistinguishable at a deploy gate from
 * the process being wedged. A missing commit is a missing field; a wedged
 * backend is an outage, and they must not look the same.
 */
export function readDeployedCommit(startDir: string = process.cwd()): string | null {
  try {
    const gitDir = findGitDir(startDir);
    if (!gitDir) return null;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (SHA.test(head)) return head;
    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (!symbolic?.[1]) return null;
    return resolveRef(gitDir, symbolic[1].trim());
  } catch {
    return null;
  }
}
