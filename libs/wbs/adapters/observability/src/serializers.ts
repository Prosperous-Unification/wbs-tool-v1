export interface SerializedError {
  type: string;
  message: string;
  stack: string;
}

export const errSerializer = (err: Error): SerializedError => ({
  type: err.constructor.name,
  message: err.message,
  stack: err.stack ?? '',
});
