import { expect, it } from 'bun:test';

import { LoginThrottle } from './login-throttle';

it('never evicts a live lock when the bounded map fills with attacker keys', () => {
  const throttle = new LoginThrottle({ now: () => 1_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throttle.recordFailure('victim', '192.0.2.1');
  }
  expect(throttle.canAttempt('victim', '192.0.2.2')).toBe(false);

  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    throttle.recordFailure(`attacker-${String(attempt)}`, `198.51.100.${String(attempt)}`);
  }

  expect(throttle.canAttempt('victim', '192.0.2.2')).toBe(false);
  expect(throttle.canAttempt('new-user', '192.0.2.3')).toBe(false);
});
