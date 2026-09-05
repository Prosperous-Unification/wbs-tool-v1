import type { PersistentDeadlineTimerCommands } from './solver-supervisor-command';
import {
  parseManagedContainerEvidence,
  parseManagedContainerId,
  parseManagedContainerList,
} from './solver-supervisor-docker-output';
import type {
  ManagedContainerAttachment,
  ManagedContainerDriver,
  ManagedContainerEvidence,
  ManagedDeadlineTimer,
} from './solver-supervisor-lifecycle';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface ManagedCommandInput {
  write(text: string): Promise<void>;
  flush(): Promise<void>;
}

export interface ManagedCommandProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  readonly input: ManagedCommandInput | null;
}

export type ManagedCommandSpawn = (
  argv: readonly string[],
  inputMode: 'ignore' | 'pipe',
) => ManagedCommandProcess;

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      yield chunk.value;
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

function spawnManagedCommand(
  argv: readonly string[],
  inputMode: 'ignore' | 'pipe',
): ManagedCommandProcess {
  if (inputMode === 'pipe') {
    const child = Bun.spawn([...argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    return {
      stdout: streamChunks(child.stdout),
      stderr: streamChunks(child.stderr),
      exited: child.exited,
      input: {
        write: async (text): Promise<void> => {
          await child.stdin.write(text);
        },
        flush: async (): Promise<void> => {
          await child.stdin.flush();
        },
      },
    };
  }
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: streamChunks(child.stdout),
    stderr: streamChunks(child.stderr),
    exited: child.exited,
    input: null,
  };
}

async function readCommandText(source: AsyncIterable<Uint8Array>, name: string): Promise<string> {
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = '';
  for await (const chunk of source) {
    byteCount += chunk.byteLength;
    if (byteCount > MAX_COMMAND_OUTPUT_BYTES) {
      throw new Error(
        `managed solver command: ${name} exceeds ${String(MAX_COMMAND_OUTPUT_BYTES)} bytes`,
      );
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function deadlineServiceFired(raw: string): boolean {
  const fields = new Map<string, string>();
  for (const line of raw.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('managed solver command: malformed deadline service state');
    const key = line.slice(0, separator);
    if (fields.has(key))
      throw new Error('managed solver command: duplicate deadline service field');
    fields.set(key, line.slice(separator + 1));
  }
  if (fields.size !== 2 || !fields.has('ActiveState') || !fields.has('Result')) {
    throw new Error('managed solver command: incomplete deadline service state');
  }
  const active = fields.get('ActiveState');
  const result = fields.get('Result');
  if (active === 'active' && result === 'success') return true;
  if ((active === 'inactive' && result === 'success') || active === 'failed') return false;
  throw new Error(
    `managed solver command: unexpected deadline service state ${String(active)}/${String(result)}`,
  );
}

/** Bun-backed Docker/systemd adapter; tests inject the same narrow process seam. */
export class BunManagedContainerDriver implements ManagedContainerDriver {
  constructor(private readonly spawn: ManagedCommandSpawn = spawnManagedCommand) {}

  private async run(argv: readonly string[]): Promise<string> {
    const child = this.spawn(argv, 'ignore');
    const [stdout, stderr, code] = await Promise.all([
      readCommandText(child.stdout, 'stdout'),
      readCommandText(child.stderr, 'stderr'),
      child.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        `managed solver command: ${argv.join(' ')} exited ${String(code)}: ${stderr.trim()}`,
      );
    }
    return stdout;
  }

  async list(argv: readonly string[]): Promise<readonly string[]> {
    return parseManagedContainerList(await this.run(argv));
  }

  async create(argv: readonly string[]): Promise<string> {
    return parseManagedContainerId(await this.run(argv));
  }

  attach(argv: readonly string[]): Promise<ManagedContainerAttachment> {
    const child = this.spawn(argv, 'pipe');
    if (child.input === null) {
      throw new Error('managed solver command: attach did not create piped input');
    }
    const input = child.input;
    return Promise.resolve({
      closed: child.exited.then(() => undefined),
      stdout: child.stdout,
      stderr: child.stderr,
      write: async (text): Promise<void> => {
        await input.write(text);
        await input.flush();
      },
    });
  }

  async armDeadline(commands: PersistentDeadlineTimerCommands): Promise<ManagedDeadlineTimer> {
    await this.run(commands.arm);
    return {
      hasFired: async (): Promise<boolean> =>
        deadlineServiceFired(await this.run(commands.inspect)),
      cancel: async (): Promise<void> => {
        await this.run(commands.cancel);
      },
    };
  }

  async start(argv: readonly string[]): Promise<void> {
    await this.run(argv);
  }

  async kill(argv: readonly string[]): Promise<void> {
    await this.run(argv);
  }

  async wait(argv: readonly string[]): Promise<void> {
    await this.run(argv);
  }

  async inspect(
    argv: readonly string[],
    deadlineKilled: boolean,
  ): Promise<ManagedContainerEvidence> {
    return parseManagedContainerEvidence(await this.run(argv), deadlineKilled);
  }

  async remove(argv: readonly string[]): Promise<void> {
    await this.run(argv);
  }
}
