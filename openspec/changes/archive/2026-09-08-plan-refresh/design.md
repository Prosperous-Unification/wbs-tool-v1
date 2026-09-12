## Authority and ownership

Implemented in the isolated `refactor/plan-refresh` worktree from merged `362c29a8`. The approved §67 R1 plan plus calendar-marker integration is the design authority. `verify.md` distinguishes observed checks from remaining integration gates.

`lib/plan-refresh.ts` owns the coordinator, without React or DOM imports. `use-plan-read.ts` remains the React adapter and mutation UI owner. `project-stream.ts` delivers event kind and sequence and retains seen() as an explicit installation acknowledgment. ProjectApi stays the transport port. No row/column implementation changes are needed.

## Public surface

Implemented public surface:

- RefreshResource names one resource; callers supply a readonly array of tree, steps, directory, markers. Named scope resolution maps tree_replaced→tree; step events→tree+steps; calendar_markers_changed→markers; directory/capacity/unknown/absent events→all, preserving broad invalidation where cross-resource consequences exist. Marker-specific narrowing is intentional here and needs a test; the preservation merge deliberately kept it broad.
- createPlanRefresh({projectId, api}) returns initialize(), invalidate({resources, seq?}), getSnapshot(), subscribe(listener), dispose(). The factory captures the API object's identity as part of the lifetime; changing credentials/API on the same project creates a new owner.
- invalidate returns Promise<RefreshOutcome>, a union of installed (requested obligation covered; generations remain in the snapshot), failed (named resource failures, retaining last installed snapshots), and disposed. It registers an obligation immediately. It never resolves installed merely because a reused HTTP request settled. Unexpected transport/programming failures are preserved as explicit failures for the adapter to surface; they are not silently converted into empty snapshots.
- getSnapshot returns a stable immutable snapshot until state changes. Each ResourceRead exposes desired generation, reading status, optional installed generation/value and optional failure generation/cause. Do not use null/empty defaults to impersonate a successfully installed resource. Top-level stale is derived from unresolved failed obligations; initial loading is rendered as loading, not as successful empty state.
- subscribe reports snapshot changes only while live. dispose is idempotent, settles pending caller outcomes as disposed, and forbids future install/notify/ack. invalidate on a disposed owner returns disposed. Disposal is a modeled lifecycle exit, not a swallowed exception.

Concrete snapshot types follow ProjectApi return types; group directory's teams/tags/services/types/external systems/people as one resource installed only after its complete read succeeds.

## Scheduling and completion

Maintain desired, running and installed generation per resource. A request captures the desired generation when it begins. Invalidating a running resource increments its desired generation and unions pending work; the pre-invalidation response cannot satisfy the newer obligation. Once the attempt settles, issue a trailing read for the dirty resource without needing another event. Multiple invalidations received before that read starts may coalesce into one covering generation. Independent resources can run concurrently; a slow steps read remains eligible when only tree received a newer invalidation.

A caller waits until every resource named by its obligation has either a covering installed generation, a covering failure, or disposal. Superseded earlier attempts do not complete that caller falsely; a later read may satisfy several callers. Preserve first-load and mutation completion semantics: run() still reports the mutation's own landed/refused outcome, while awaiting its refresh outcome before releasing the UI's existing busy/focus lifecycle. A committed mutation followed by read failure is still a committed mutation with stale state, not a refused write.

Failures retain the last installed value and resource-specific stale state. A later successful tree read cannot clear failed markers/directory/steps. A failed attempt does not create an unbounded self-retry loop: consume any already-pending later obligation, then wait for Retry or another invalidation. Retry invalidates all unresolved resources (or all resources for the existing broad Retry action). If a grouped directory member fails, do not publish a partially replaced vocabulary group.

No URL-only dedup remains in wbs-api.ts. Sharing belongs to the same coordinator generation only. A second coordinator/API caller must get its own transport read; independent request owners cannot lend a pre-edit promise to a later invalidation. There is no existing AbortController machinery to remove; do not invent cancellation as a prerequisite. Outstanding network work may settle after disposal, but its result has no live authority.

## Stream coverage and acknowledgment

Forward the actual frame.seq through onChange instead of discarding it. Record each observed sequenced invalidation with the resources and desired generations it requires. Advance acknowledgment only through the highest contiguous sequence after the baseline whose obligations are all covered by installed generations. Never acknowledge a failed or superseded obligation, nor bypass an earlier failed marker obligation because a later tree read answered a larger seq. Resource responses without sequences (steps/directory/markers) are covered by reads started after the corresponding observed invalidation; do not manufacture resource sequence fields.

Tree response sequences are NOT permission to acknowledge unobserved events. Bootstrap first reads tree anchor A, then starts and installs the unsequenced resources used for baseline coverage. Pass that stable anchor into the table subscription factory instead of ProjectPage's hardcoded -1. Existing subscribeToProject onOpen sends subscribe then resume(A); no new stream method is required for this path. This delays initial presence/subscription until baseline readiness, an intentional lifecycle change that must be named and tested. Do not restart the subscription on every subsequent tree response. The factory argument initializes the cursor exactly once; the adapter calls seen only for later covered event advances or completed anchored recovery. An initial seen(anchor) would duplicate the factory argument and conceal wiring faults. Generic stream callers passing -1 retain their explicit no-history-replay behavior. Baseline failures stay visible until recovery; resume denial starts a bounded anchored resync epoch.

After baseline, acknowledgment advances only through contiguous covered event sequences for the subscription, never an arbitrary newer tree response seq. GatewayBroadcaster records under lock but pushes outside it, so live C can overtake B. event-log.ts sequences are contiguous per subscription. Receiving C across unseen B must initiate bounded replay or anchored all-resource resync and must not acknowledge C from its known scope alone. Keep the existing registered stream throughout anchored recovery. Its live events cover the read interval; once all resources cover the new anchor, advance its seen cursor. Replacing the socket would immediately request replay again and turn persistent denial or an empty replay acknowledgment into an unbounded read/socket loop. A real disconnect still reconnects with the installed cursor and can request a new recovery. If that happens during a held recovery, retain the new covering obligation. ack-audit.md supplies the exact source evidence and held marker/tree/socket/publisher timelines. The reconnect and initial registration timelines now have observed mutation proofs; production broadcaster overtaking is separately proved in verify.md.

Separately fetched endpoints still have no common transaction contract. Reading unsequenced resources after the anchor establishes coverage of the anchor and replay captures later changes; it does not manufacture a server-atomic snapshot. Preserve resource-generation obligations during replay/resync, teardown guards and explicit loading/stale outcomes.

## React adaptation

Replace latestRefresh/latestMarkerRead plus separate marker initial effect with coordinator state. Keep the current sameSteps identity preservation, toTree/row placement derivation, draft/refusal cleanup and hover settlement in use-plan-read. Publish ChartRead entirely from one installed tree PlanRead (its slices, steps and assignedPeople), never from the separate steps/directory resources and never as separate field effects; keep existing capacity/estimate/start-date handling and accepted step-change focus behavior. An unrelated tree or marker update must not create new steps/columns identities.

The adapter identifies which resources changed by installed generation and only applies those setters. It does not clear stale from a success callback; it renders the coordinator's freshness. Surface initial failure and mutation refusal through the existing wording, but suppress all old-owner toast/stale/install/ack effects after project/API departure. Marker writes still reread on refusal, because the rejected marker may have been deleted remotely; they invalidate markers only. Local tree mutations, settings, undo/redo and dependencies retain their established resource scopes and completion behavior.

Create/dispose the owner so React StrictMode setup→cleanup→setup obtains a fresh live owner. A useMemo-created coordinator disposed by the first cleanup and reused on the second setup is invalid. Compare API identity even when projectId is unchanged. Remove the old stream ref and transport ownership only when the adapter routes every caller; do not leave two subscriptions or competing initial loads.

## Non-vacuous testing

Use real httpProjectApi with held fetch responses to reproduce URL sharing. A strictly serial coordinator can mask the old map within one instance: include overlapping API/coordinator lifetimes or an independent real API caller holding the same URL when the later owner invalidates. Ensure the held response contains the old sequence/value; wait for the later response's installed figure/identity before reading the editor. Request counts alone do not prove publication.

Test wider/narrower overlap independently of URL sharing. Inject a single global generation and require an earlier renamed steps/directory/initial-scope result to be lost at the assertion; preserve a no-competing-tree control. Repeat for marker reads and refusal rereads. Use literal held-response milestones rather than retrying absence assertions or timers derived from the faulty constant. Record the precise observed failure before Proof comments.

## Empty-history cursor disposition — approved by parent

Allow exactly the modeled sentinel -1 in ResumePoints: safe integers from -1 through MAX_SAFE_INTEGER. Backend ReplayOrchestrator already accepts -1 and event-log.latestSeq returns it before first event0, so this repairs the cross-tier contract. Preserve rejection of -2, fractions, non-finite/unsafe values, arrays and malformed frames. Update the existing R4 negative fixture from -1 to -2 and record the intentional correction/proof under R1. Do not clamp an empty baseline to0.

The `hasBaseline: true` option provides explicit resume-baseline intent to subscription options so a covered-empty baseline (-1 with resume intent) requests replay, while generic never-read callers (-1 without that intent) retain their existing subscribe-without-history behavior. The numeric cursor alone cannot represent both meanings. A normal nonnegative baseline still uses existing subscribe-then-resume ordering.

Required production proof: actual gateway ingress accepts explicit resume_points at -1 and the backend can replay first event0; below-sentinel -2 and all other existing malformed categories remain refused, with connection usable afterward. Inject the old >=0 bound and watch the empty-baseline browser/stream integration fail at the real socket boundary. Also hold registration across the first event and require event0's marker state to install without event1. Preserve generic -1 no-resume tests and add covered-empty explicit-resume tests.

The narrow contracts/ws correction and gateway ingress/controller tests are included. Gateway app wiring and contracts/http remain outside this change.

### Physical socket callback ownership

Project-stream captures an epoch for each physical socket. Close invalidates that epoch before scheduling reconnect; open/message/close from a previous socket cannot send frames through the new socket, request recovery, publish presence, change connection state or schedule another reconnect. Unsubscription also invalidates callback authority, including synchronous unsubscription inside a recovery callback before the stream would report synchronization.
