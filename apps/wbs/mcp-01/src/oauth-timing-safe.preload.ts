import * as crypto from 'node:crypto';

import { mock } from 'bun:test';

interface TimingSafeEqualCall {
  leftBytes: number;
  rightBytes: number;
}

declare global {
  var timingSafeEqualCalls: TimingSafeEqualCall[];
}

globalThis.timingSafeEqualCalls = [];
const nativeTimingSafeEqual = crypto.timingSafeEqual.bind(crypto);

await mock.module('node:crypto', () => ({
  ...crypto,
  timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView): boolean => {
    globalThis.timingSafeEqualCalls.push({
      leftBytes: left.byteLength,
      rightBytes: right.byteLength,
    });
    return nativeTimingSafeEqual(left, right);
  },
}));

export {};
