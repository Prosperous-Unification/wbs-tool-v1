import { type } from '@wbs/validation';

export const LogRecord = type({
  level: "'trace'|'debug'|'info'|'warn'|'error'|'fatal'|10|20|30|40|50|60",
  time: 'number',
  msg: 'string',
  service: "'be-01'|'gw-01'|'fe-01'",
  'request_id?': 'string',
  'connection_id?': 'string',
  'user_id?': 'string',
  'ws_subscription?': 'string',
  'trace_id?': 'string',
  'span_id?': 'string',
  'version?': 'string',
  'err?': {
    name: 'string',
    message: 'string',
    'stack?': 'string',
  },
  '[string]': 'unknown',
});
export type LogRecord = typeof LogRecord.infer;
