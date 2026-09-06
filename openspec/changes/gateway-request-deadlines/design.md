## Context

The approved §67 R9 addresses the former unbounded request paths: push retried selected HTTP statuses without fetch/body deadlines; forward made one unbounded attempt; inline resume omitted cancellation and the HTTP status check. Broadcaster already records under the write lock, releases it before awaiting delivery, and reports delivery failure without refusing the committed edit.

## Goals / Non-Goals

Bound every asynchronous request phase with one overall deadline, cancel the actual transport, and preserve application failure/commit semantics. Do not introduce a delivery worker or widen gateway presence ownership while R7 is active. Do not treat synchronous CPU work or a blocked JavaScript event loop as timer-preemptible.

## Decisions

### Capability placement and ownership

The deadline implementation is a portable runtime adapter, consistent with ports-plan runtime-portable placement. It belongs in `libs/runtime-portable` when the cross-app capability is introduced, with a minimal Nx public surface and explicit runtime/dependency tags matching the existing workspace convention. It must not live in contracts/domain or be imported from be-01 by gw-01. If the first backend slice precedes creation of that project, a narrowly scoped backend adapter module may stage the implementation temporarily; move it once when gateway integration begins, before adding any cross-app import. Record that staging path explicitly, never duplicate its retry/deadline semantics across apps.

The application consumes small injected capabilities: a monotonic nowMs clock, cancellable timer scheduling/clearing (or cancellable delay), and transport execution taking AbortSignal. Budgets are explicit composition inputs; validate positive finite attempt/overall values and nonnegative integer retry count. Root composition supplies real timers/fetch, tests supply controlled capabilities. Core's future Timers/PushTransport ports describe capabilities; core must not import runtime-portable. No global defaults silently appear inside the future extracted application layer. Audit Clock now/newId/stamp is a different purpose and is not repurposed.

Backend first: push-client, scoped adapter/helper, services/boot composition as agreed with parent, and broadcaster proof tests. Gateway client/resume extraction and app/controller lifecycle wiring start only after R7 releases connection ownership. Existing health probe timeout remains independent.

### Logical request and attempt lifetime

One logical request owns immutable overall expiry, retry count and parent cancellation. Every attempt owns an AbortController; its timer expires at min(attempt budget, remaining overall budget). The active signal remains connected through fetch headers AND success json/error text consumption. Clearing timers at headers is wrong. Dispose listeners/timers on every exit; cancel unused response bodies before retry.

Check remaining time before a new fetch or backoff and after awaited phases. Overall timeout also cancels a backoff already in progress. An already-aborted parent starts no transport. Parent cancellation is a controlled terminal outcome, never retried as a transient network failure. Preserve the reason distinguishing caller cancellation, attempt expiry and overall expiry so mapping is deliberate.

A Promise.race alone cannot establish transport cancellation. If used to bound a non-cooperative injected dependency, the losing operation must still receive abort; report the adapter contract violation rather than call a dangling request canceled. Real fetch integration must show a stalled body stops, not just that the outer promise rejects. Timer guarantees assume the event loop can run; no hard wall-clock claim during synchronous serialization/parsing stalls.

### Failure taxonomy and retry policy

Preserve PushClient's additional-retries meaning: maxRetries0 means one attempt. Keep transient status5xx/408/429 and permanent other4xx behavior, with existing backoff500ms doubling/cap30000, all clipped by overall budget. Keep identical serialized push payload across retries; never allocate another durable event/sequence for delivery retry.

Classify network rejection at the concrete transport boundary using observed platform error cases, returning a narrow owned transient outcome. Do not catch every TypeError/Error as transient: programmer exceptions, malformed trusted acknowledgement JSON/schema and unknown dependency errors propagate. Invalid JSON after an otherwise successful request is not automatically retriable network failure. Caller cancellation does not report backend unavailability on an already closed socket.

Forward currently has one attempt; retain that unless an owned idempotency contract explicitly supports retries. Resume is read-only, but bounded one-attempt behavior suffices initially. Inspect non-OK resume status before parsing a success body; valid-looking JSON on503 must not become successful replay. Preserve current forward backend_unavailable and resume_denied/final-ack mappings on live connections. Unknown failures must remain distinguishable at the client boundary even where existing controller mapping reports an unavailable wire outcome.

Broadcaster's existing delivery reporting catches failure after commit. Deadline changes must not move push under lock or rethrow a delivery failure as command refusal. Preserve durable event/replay despite timeout. Cancellation of the originating HTTP caller does not undo committed database state or create an unbounded background task. Future worker queue/concurrency design remains a separate measured change.

### Production composition values

Before implementation, inspect current deploy/caller latency expectations and select explicit attempt/overall values in the R9 artifact; do not claim measured optimal values. Tests inject small literal budgets. No user design interview is needed for this routine implementation choice. All production callers must receive the same intended policy through composition, rather than tests exercising an option no production caller passes.

### Gateway lifecycle after R7

Connection composition owns cancellation for its outstanding forward/resume calls. On close, abort transport and prevent late sends/failure metrics for the departed connection while preserving R7's serialized join/leave and R4's valid-frame processing. Thread the signal through closures/client calls without putting presence state inside the portable deadline helper. Preserve the socket's ability to handle a subsequent ping after a live-connection timeout.

## Risks / Trade-offs

A deterministic fake can falsely prove cancellation if it only rejects its own promise on a timer; assert signal observation/body termination, then reproduce with actual Bun fetch and a held streaming HTTP response. A real server test may require the parent's listener permission path; report inability explicitly rather than substituting a fake claim. Failed schema/body parsing is distinct from a body stalled awaiting bytes. Do not remove one because the other test passed.

An overall deadline can make a configured retry count unreachable; this is expected and must not extend the deadline to honor every retry. Preserve deterministic timeout ordering at exact expiry. Collect proof output first, then write adjacent Proof comments. Observed proof outputs and restored verification live in verify.md.

## Backend implementation checkpoint decisions

Initial production policy is attempt5000ms, overall15000ms, maxRetries5, passed explicitly by services.ts with fetch/systemTimers. These are bounded initial defaults, not measured latency optima. The backend checkpoint staged the helper at apps/be-01/src/runtime/deadline.ts. After R7 handoff it moved once to libs/runtime-portable; backend and gateway import that package independently. Existing test-only sleep injection remains cancellably awaited for compatibility; production uses scheduled cancellable delay.

Real Bun1.3.14 loopback streaming tests observed server-side request/stream cancellation for stalled headers and body. Omitting fetch signal left outer deadline settlement intact and failed both tests on expected true/received false for actual cancellation. Sandbox ephemeral listeners were denied; the focused real-server run used escalation. Initial invalid port fetch probe returned Error code FailedToOpenSocket; explicit socket errno variants remain the narrowly enumerated transport conditions, not blanket TypeError recovery.

## Gateway implementation decisions

`requestBackend` owns the one-attempt HTTP adapter shared by ForwardClient and ResumeClient. It validates positive finite budgets, runs fetch/status/body/schema work within min(attemptMs, overallMs), and propagates unknown failures unchanged. Neither operation retries. buildApp explicitly supplies real fetch/systemTimers and attempt5000ms/overall15000ms, with a typed requests seam for deterministic policy tests. Health retains its existing independent2000ms AbortSignal.timeout.

Every connection creates its AbortController synchronously in open. Close aborts it before awaiting joined; join/leave/presence ownership remains with R7. The controller checks that lifetime after failed forward/resume and successful resume before any late reply or failure metric. Existing live-wire unavailable/denied/ack behavior stays intact. No extra early-dispatch guard was retained: the held-verifier probe could not establish the proposed real-socket dispatch window, so no speculative safety proof is attached to it.

The runtime-portable Nx library has ring:adapter, runtime:isomorphic and product:wbs tags, source/spec typecheck, lint and test targets. Its exported timer/deadline APIs use standard runtime primitives, and its testing subpath owns the shared deterministic clock. No package dependencies changed.
