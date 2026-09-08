type Environment = Readonly<Record<string, string | undefined>>;

export const CORPUS_BOUNDARY_EVENTS = [
  'pull_request',
  'push',
  'merge_group',
  'workflow_dispatch',
] as const;

type CorpusBoundaryEvent = (typeof CORPUS_BOUNDARY_EVENTS)[number];

function requireEnv(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requireSha(environment: Environment, name: string): string {
  const sha = requireEnv(environment, name);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${name} is not a full lowercase Git SHA: ${sha}`);
  }
  return sha;
}

function isCorpusBoundaryEvent(eventName: string): eventName is CorpusBoundaryEvent {
  return CORPUS_BOUNDARY_EVENTS.some((supportedEvent) => supportedEvent === eventName);
}

function readGit(args: readonly string[]): string {
  const invocation = Bun.spawnSync({
    cmd: ['git', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (invocation.exitCode !== 0) {
    const message = new TextDecoder().decode(invocation.stderr).trim();
    throw new Error(message.length === 0 ? `git ${args.join(' ')} failed` : message);
  }
  return new TextDecoder().decode(invocation.stdout).trim();
}

function mergeBase(revision: string): string {
  return readGit(['merge-base', '--', revision, 'HEAD']);
}

/**
 * Chooses the immutable revision that CI compares with `HEAD`.
 *
 * Pull-request events must carry the base commit used to build their synthetic
 * merge. A named base branch may move before a rerun, so it is diagnostic text
 * only and never a comparison fallback.
 */
export function chooseCorpusBase(environment: Environment): string {
  const eventName = requireEnv(environment, 'EVENT_NAME');
  if (!isCorpusBoundaryEvent(eventName)) {
    throw new Error(`corpus-version-lint has no boundary rule for event ${eventName}`);
  }
  switch (eventName) {
    case 'pull_request': {
      return mergeBase(requireSha(environment, 'PR_BASE_SHA'));
    }
    case 'push':
      return requireEnv(environment, 'PUSH_BEFORE');
    case 'merge_group':
      return mergeBase(requireSha(environment, 'MERGE_GROUP_BASE_SHA'));
    case 'workflow_dispatch':
      return mergeBase(requireEnv(environment, 'DISPATCH_BASE_REF'));
  }
}

if (import.meta.main) process.stdout.write(`${chooseCorpusBase(process.env)}\n`);
