import { smokeEcho } from '@wbs/contracts';

import { bind } from '../http/endpoint';
import { SmokeService } from '../service/smoke.service';

/** Binds the deploy echo to its shared request, response and refusal declaration. */
export function smokeRoutes() {
  const smoke = new SmokeService();
  return [
    bind(smokeEcho, ({ body }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: { echoed: smoke.echo(body.text) },
      }),
    ),
  ] as const;
}
