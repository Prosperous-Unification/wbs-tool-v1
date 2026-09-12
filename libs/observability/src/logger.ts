import type { Logger } from '@wbs/contracts';
import pino, { type LoggerOptions } from 'pino';

import { errSerializer } from './serializers';

export { type Logger, noopLogger } from '@wbs/contracts';

export type ServiceName = 'be-01' | 'gw-01' | 'fe-01';

export interface CreateLoggerOptions {
  service: ServiceName;
  version?: string;
  level?: string;
  destination?: { write(chunk: string): void };
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const base: Record<string, unknown> = { service: opts.service };
  if (opts.version) base['version'] = opts.version;

  const options: LoggerOptions = {
    level,
    base,
    timestamp: () => `,"time":${String(Date.now())}`,
    serializers: { err: errSerializer },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  return opts.destination ? pino(options, opts.destination) : pino(options);
}
