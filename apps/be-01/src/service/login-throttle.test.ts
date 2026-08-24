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
  throttle.recordSuccess('attacker-2000');
  throttle.recordSuccess('attacker-2001');

  expect(throttle.canAttempt('victim', '192.0.2.2')).toBe(false);
  expect(throttle.canAttempt('new-user', '192.0.2.3')).toBe(true);
});

it('bounds attacker-controlled usernames before retaining them as map keys', () => {
  const throttle = new LoginThrottle({ now: () => 1_000 });
  const prefix = 'a'.repeat(32);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throttle.recordFailure(`${prefix}-${String(attempt)}`, `192.0.2.${String(attempt)}`);
  }

  expect(throttle.canAttempt(`${prefix}-different-suffix`, '198.51.100.1')).toBe(false);
});
