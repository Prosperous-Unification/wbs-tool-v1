export const ErrorCode = {
  BackendUnavailable: 'backend_unavailable',
  AuthFailure: 'auth_failure',
  InvalidPayload: 'invalid_payload',
  OutOfRange: 'out_of_range',
  RateLimited: 'rate_limited',
  Internal: 'internal',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
