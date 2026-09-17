import { parseOrThrow } from '@wbs/validation';
import { describe, expect, it } from 'bun:test';

import { LogRecord } from './log-schema';
import { createLogger } from './logger';

describe('createLogger', () => {
  it('emits records conforming to the LogRecord schema', () => {
    const stream: string[] = [];
    const logger = createLogger({
      service: 'be-01',
      version: 'test-sha',
      destination: {
        write: (chunk: string) => {
          stream.push(chunk);
        },
      },
    });

    logger.info({ request_id: 'req-1', user_id: 'u-1' }, 'hello');

    const record = JSON.parse(stream.at(-1)!) as Record<string, unknown>;
    const parsed = parseOrThrow(LogRecord, record);
    expect(parsed.service).toBe('be-01');
    expect(parsed.request_id).toBe('req-1');
    expect(parsed.msg).toBe('hello');
    expect(parsed.version).toBe('test-sha');
  });

  it('child logger inherits context', () => {
    const stream: string[] = [];
    const base = createLogger({
      service: 'gw-01',
      version: 'v1',
      destination: {
        write: (c: string) => {
          stream.push(c);
        },
      },
    });
    const child = base.child({ connection_id: 'c-1', ws_subscription: 'doc:abc' });
    child.warn('test');
    const rec = JSON.parse(stream.at(-1)!) as Record<string, unknown>;
    expect(rec['connection_id']).toBe('c-1');
    expect(rec['ws_subscription']).toBe('doc:abc');
  });
});
