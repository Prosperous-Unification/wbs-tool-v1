export class ValidationError extends Error {
  override name = 'ValidationError' as const;
  // `override`: ES2022's Error carries `cause`, so this is a narrowing of an
  // inherited member rather than a new one.
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
