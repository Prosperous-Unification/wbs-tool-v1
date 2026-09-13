export type LogFields = Record<string, unknown>;

export interface LogMethod {
  (message: string): void;
  (fields: LogFields, message: string): void;
}

/** The logging surface shared by application code and runtime adapters. */
export interface Logger {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  child(fields: LogFields): Logger;
}

const discardLog: LogMethod = () => undefined;

/** A logger for compositions that deliberately retain no diagnostic output. */
export const noopLogger: Logger = {
  info: discardLog,
  warn: discardLog,
  error: discardLog,
  child: () => noopLogger,
};
