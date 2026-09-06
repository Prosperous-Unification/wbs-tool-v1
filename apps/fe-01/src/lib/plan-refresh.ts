import type {
  CalendarMarkerView,
  ExternalSystemView,
  PersonView,
  PlanRead,
  ProjectApi,
  ServiceView,
  StepView,
  TagView,
  TeamView,
  WorkItemTypeView,
} from './wbs-api';

export type RefreshResource = 'tree' | 'steps' | 'directory' | 'markers';
export const ALL_RESOURCES: readonly RefreshResource[] = ['tree', 'steps', 'directory', 'markers'];

/** Unknown events may affect any resource; narrowing is a claim about known events only. */
export function resourcesFor(changed?: string | null): readonly RefreshResource[] {
  if (changed === 'tree_replaced') return ['tree'];
  if (changed === 'step_added' || changed === 'step_renamed' || changed === 'step_removed') {
    return ['tree', 'steps'];
  }
  if (changed === 'calendar_markers_changed') return ['markers'];
  return ALL_RESOURCES;
}

/** Vocabularies install as a group so a failed member cannot leave mixed labels. */
export interface DirectoryRead {
  teams: TeamView[];
  tags: TagView[];
  services: ServiceView[];
  workItemTypes: WorkItemTypeView[];
  externalSystems: ExternalSystemView[];
  people: PersonView[];
}

export interface ResourceRead<T> {
  desired: number;
  reading: boolean;
  installed: { generation: number; value: T } | null;
  failure: { generation: number; cause: unknown } | null;
}

export interface RefreshFailure {
  resource: RefreshResource;
  cause: unknown;
}

export type RefreshOutcome =
  | { status: 'installed' }
  | { status: 'failed'; failures: readonly RefreshFailure[] }
  | { status: 'disposed' };

export interface PlanRefreshSnapshot {
  tree: ResourceRead<PlanRead>;
  steps: ResourceRead<readonly StepView[]>;
  directory: ResourceRead<DirectoryRead>;
  markers: ResourceRead<readonly CalendarMarkerView[]>;
  staleResources: readonly RefreshResource[];
  /** A covered anchor, replaced only by an explicit full resynchronization. */
  baseline: { seq: number; epoch: number } | null;
  acknowledged: number;
}

interface Obligation {
  resource: RefreshResource;
  generation: number;
}

interface Waiter {
  obligations: readonly Obligation[];
  resolve: (outcome: RefreshOutcome) => void;
}

interface ResourceControl {
  invalidate(): number;
  start(): void;
  fail(cause: unknown): void;
  installedGeneration(): number;
  failure(): ResourceRead<unknown>['failure'];
}

/**
 * One resource's generations. A running read cannot satisfy an invalidation
 * received after it started; the later desired generation causes a trailing read.
 */
function resourceRead<T>(
  load: () => Promise<T>,
  canRead: () => boolean,
  isDisposed: () => boolean,
  changed: () => void,
): ResourceControl & { snapshot(): ResourceRead<T> } {
  let reading = false;
  let attempted = 0;
  let desired = 0;
  let installed: ResourceRead<T>['installed'] = null;
  let failure: ResourceRead<T>['failure'] = null;

  async function read(generation: number): Promise<void> {
    let answer: { ok: true; value: T } | { ok: false; cause: unknown };
    try {
      answer = { ok: true, value: await load() };
    } catch (cause) {
      answer = { ok: false, cause };
    }
    if (isDisposed()) return;
    reading = false;
    // Proof: accepting a superseded response changed installed generation1 to2
    // while its covering read was held in `does not install or complete a superseded read`.
    if (generation === desired) {
      if (answer.ok) {
        installed = { generation, value: answer.value };
        failure = null;
      } else {
        failure = { generation, cause: answer.cause };
      }
    }
    changed();
    // Proof: removing this continuation left one request instead of two in
    // `installs B with a trailing read without a third invalidation`.
    start();
  }

  function start(): void {
    if (isDisposed() || !canRead() || reading || attempted >= desired) return;
    attempted = desired;
    reading = true;
    void read(attempted);
  }

  return {
    invalidate() {
      desired += 1;
      return desired;
    },
    start,
    fail(cause) {
      failure = { generation: desired, cause };
      attempted = desired;
    },
    installedGeneration: () => installed?.generation ?? 0,
    failure: () => failure,
    snapshot: () => ({ desired, reading, installed, failure }),
  };
}

export interface PlanRefresh {
  /** Establishes an anchored baseline, coalescing concurrent resync requests. */
  initialize(): Promise<RefreshOutcome>;
  invalidate(invalidation: {
    resources: readonly RefreshResource[];
    seq?: number;
  }): Promise<RefreshOutcome>;
  getSnapshot(): PlanRefreshSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * Owns reads for one project/API lifetime. React consumes installed generations;
 * no transport promise, URL cache or unrelated resource decides their authority.
 * See openspec/changes/plan-refresh/design.md for bootstrap and sequence coverage.
 */
export function createPlanRefresh({
  projectId,
  api,
}: {
  projectId: string;
  api: ProjectApi;
}): PlanRefresh {
  let disposed = false;
  const isDisposed = (): boolean => disposed;
  let unsequencedAllowed = false;
  let baseline: PlanRefreshSnapshot['baseline'] = null;
  let acknowledged = -1;
  let received = -1;
  let epoch = 0;
  let initializing: Promise<RefreshOutcome> | null = null;
  let requestedBaseline = 0;
  const listeners = new Set<() => void>();
  const waiters = new Set<Waiter>();
  const events = new Map<number, readonly Obligation[]>();
  const tree = resourceRead(
    () => api.tree(projectId),
    () => true,
    () => disposed,
    publish,
  );
  const steps = resourceRead(
    () => api.steps(projectId),
    () => unsequencedAllowed,
    () => disposed,
    publish,
  );
  const directory = resourceRead(
    async (): Promise<DirectoryRead> => {
      const [teams, tags, services, workItemTypes, externalSystems, people] = await Promise.all([
        api.listTeams(),
        api.listTags(),
        api.listServices(),
        api.listWorkItemTypes(),
        api.listExternalSystems(),
        api.listPeople(),
      ]);
      return { teams, tags, services, workItemTypes, externalSystems, people };
    },
    () => unsequencedAllowed,
    () => disposed,
    publish,
  );
  const markers = resourceRead(
    () => api.listCalendarMarkers(projectId),
    () => unsequencedAllowed,
    () => disposed,
    publish,
  );
  // Proof: replacing these per-resource generations with one host-wide generation made the
  // mounted held-step overlap test lose "Renamed step" while its no-competing control passed.
  const resources: Record<RefreshResource, ResourceControl> = { tree, steps, directory, markers };
  let snapshot: PlanRefreshSnapshot = capture();

  function capture(): PlanRefreshSnapshot {
    return {
      tree: tree.snapshot(),
      steps: steps.snapshot(),
      directory: directory.snapshot(),
      markers: markers.snapshot(),
      staleResources: ALL_RESOURCES.filter((name) => resources[name].failure() !== null),
      baseline,
      acknowledged,
    };
  }

  function isCovered(obligation: Obligation): boolean {
    return resources[obligation.resource].installedGeneration() >= obligation.generation;
  }

  function outcomeOf(obligations: readonly Obligation[]): RefreshOutcome | null {
    const failures: RefreshFailure[] = [];
    for (const obligation of obligations) {
      if (isCovered(obligation)) continue;
      const failure = resources[obligation.resource].failure();
      if (failure === null || failure.generation < obligation.generation) return null;
      failures.push({ resource: obligation.resource, cause: failure.cause });
    }
    return failures.length === 0 ? { status: 'installed' } : { status: 'failed', failures };
  }

  function publish(): void {
    if (isDisposed()) return;
    for (;;) {
      const next = events.get(acknowledged + 1);
      if (!next?.every(isCovered)) break;
      acknowledged += 1;
      events.delete(acknowledged);
    }
    // Proof: acknowledging tree.seq here resumed at1 rather than0 in the real
    // API/stream `does not resume past unseen marker B` reconnect scenario.
    // Clearing freshness here instead failed `keeps failed markers stale` on
    // expected ['markers'], received []. Freshness belongs to each resource.
    snapshot = capture();
    for (const listener of listeners) listener();
    for (const waiter of waiters) {
      const outcome = outcomeOf(waiter.obligations);
      if (outcome === null) continue;
      waiters.delete(waiter);
      waiter.resolve(outcome);
    }
  }

  function request(names: readonly RefreshResource[], seq?: number): Promise<RefreshOutcome> {
    if (isDisposed()) return Promise.resolve({ status: 'disposed' });
    const obligations = [...new Set(names)].map((resource) => ({
      resource,
      generation: resources[resource].invalidate(),
    }));
    if (seq !== undefined && seq > acknowledged) events.set(seq, obligations);
    const pending = new Promise<RefreshOutcome>((resolve) => {
      waiters.add({ obligations, resolve });
    });
    for (const obligation of obligations) resources[obligation.resource].start();
    publish();
    return pending;
  }

  async function establish(): Promise<RefreshOutcome> {
    unsequencedAllowed = false;
    // Proof: reading markers before this anchor left Launch absent in the real
    // API/stream `does not use a marker response captured before the initial tree anchor`.
    const anchored = await request(['tree']);
    if (anchored.status !== 'installed') {
      if (anchored.status === 'failed') {
        for (const name of ['steps', 'directory', 'markers'] as const)
          resources[name].fail(anchored.failures);
        publish();
      }
      return anchored;
    }
    if (isDisposed()) return { status: 'disposed' };
    const anchor = tree.snapshot().installed;
    if (anchor === null) throw new Error('a completed tree read has no installed anchor');
    unsequencedAllowed = true;
    const completed = await request(['steps', 'directory', 'markers']);
    if (completed.status !== 'installed') return completed;
    if (isDisposed()) return { status: 'disposed' };
    epoch += 1;
    baseline = { seq: anchor.value.seq, epoch };
    acknowledged = Math.max(acknowledged, anchor.value.seq);
    received = Math.max(received, acknowledged);
    for (const seq of events.keys()) if (seq <= acknowledged) events.delete(seq);
    publish();
    return { status: 'installed' };
  }

  function initialize(): Promise<RefreshOutcome> {
    if (isDisposed()) return Promise.resolve({ status: 'disposed' });
    // Proof: joining without retaining a later gap left After gap undefined in
    // `retains a new sequence gap ... while an anchored resync is reading markers`.
    requestedBaseline += 1;
    if (initializing !== null) return initializing;
    const establishPending = async (): Promise<RefreshOutcome> => {
      for (;;) {
        const requested = requestedBaseline;
        const outcome = await establish();
        if (isDisposed() || requested === requestedBaseline) return outcome;
      }
    };
    initializing = establishPending().finally(() => {
      initializing = null;
    });
    return initializing;
  }

  return {
    initialize,
    invalidate({ resources: names, seq }) {
      if (isDisposed()) return Promise.resolve({ status: 'disposed' });
      if (!unsequencedAllowed && initializing === null) return initialize();
      if (seq !== undefined) {
        if (seq <= acknowledged) return Promise.resolve({ status: 'installed' });
        const gap = seq > received + 1;
        received = Math.max(received, seq);
        // Proof: keeping only the known tree scope left Missed marker undefined
        // in `recovers an unseen sequence gap ... without another frame`; the real
        // API/stream `covers an unseen marker ...` also lost Launch with that fault.
        if (gap) return initialize();
      }
      return request(names, seq);
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (isDisposed()) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      // Proof: removing disposal changed snapshot identity after both late resolve
      // and late reject in `ends pending obligations on disposal`.
      disposed = true;
      listeners.clear();
      for (const waiter of waiters) waiter.resolve({ status: 'disposed' });
      waiters.clear();
    },
  };
}
