export interface WsFrame {
  subscription: string;
  seq: number;
  message: unknown;
}

let globalSeq = 0;

export function makeFrame(overrides: Partial<WsFrame> = {}): WsFrame {
  globalSeq += 1;
  return {
    subscription: 'test:subscription',
    seq: globalSeq,
    message: { type: 'ping' },
    ...overrides,
  };
}
