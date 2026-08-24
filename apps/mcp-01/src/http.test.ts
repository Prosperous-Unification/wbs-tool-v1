import { describe, expect, it } from 'bun:test';

import { healthResponse } from './http';

describe('healthResponse', () => {
  // Proof: deleting any probe branch made its expected response undefined.
  it('exposes liveness, readiness, and ALB readiness separately', async () => {
    for (const path of ['/health/liveness', '/health/readiness', '/health/alb-readiness']) {
      const response = healthResponse(new URL(`https://mcp.example${path}`));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ status: 'ok' });
    }
    expect(healthResponse(new URL('https://mcp.example/mcp'))).toBeUndefined();
  });
});
