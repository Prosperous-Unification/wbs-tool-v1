import { LoginThrottle } from '@wbs/core';

/** Fresh password admission state for one isolated HTTP test composition. */
export function testLoginThrottle(maxConcurrent = 8, now: () => number = Date.now): LoginThrottle {
  return new LoginThrottle({ now, maxConcurrent });
}
