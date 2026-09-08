import { openConnection } from '../repository/db';
import { SavedPlanRepository } from '../repository/saved-plan';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { nodeDigest } from '../runtime/bun-runtime';
import { SavedPlanService } from '../service/saved-plan.service';

/**
 * A {@link SavedPlanService} for the callers that want the routes registered
 * and none of the behaviour behind them.
 *
 * Unlike this folder's other doubles there is no in-memory store to build: both
 * saved-plan repositories are defined by taking their **own SQLite connection**
 * — the capture needs a read snapshot on a second connection, and the rename
 * and the delete refuse to wait for the write lock — so a Map-backed stand-in
 * would not be a smaller version of the thing, it would be a different one.
 *
 * So the double is the real service over a connection factory that **throws**.
 * Route registration touches no service, which is exactly what makes that
 * honest here: `testApp` gets its routes, and a test that reaches a saved-plan
 * handler with this double fails loudly on the line that tried, rather than on
 * an empty list that looks like an answer. A test that wants behaviour passes
 * {@link savedPlanServiceOn} with a real database file.
 */
export function testSavedPlanService(): SavedPlanService {
  const refuse = (): never => {
    throw new Error(
      'testSavedPlanService is route-registration only; pass savedPlanServiceOn(path) to exercise a saved-plan route',
    );
  };
  return new SavedPlanService({
    digest: nodeDigest,
    capture: new SavedPlanCaptureRepository({ openConnection: refuse }),
    plans: new SavedPlanRepository({ openConnection: refuse }),
    newId: refuse,
    now: refuse,
  });
}

/**
 * A real {@link SavedPlanService} over a migrated database file, for the tests
 * that drive the routes.
 *
 * `newId` and `now` are injected for the reason they exist on the service at
 * all: a test names the row it then reads, and stamps it with an instant an
 * assertion can quote.
 */
export function savedPlanServiceOn(
  path: string,
  parts: { newId?: () => string; now?: () => number } = {},
): SavedPlanService {
  let minted = 0;
  return new SavedPlanService({
    digest: nodeDigest,
    capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
    plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
    newId:
      parts.newId ??
      ((): string => {
        minted += 1;
        return `sp-${String(minted)}`;
      }),
    now: parts.now ?? ((): number => Math.floor(Date.now() / 1000)),
  });
}
