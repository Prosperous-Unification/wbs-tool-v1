## 1. Establish observable failures

- [x] 1.1 Add held real-httpProjectApi tree A/notify B coverage and prove old URL sharing installs stale state without a third event. Include overlapping API lifetimes or an independent API caller so serial scheduling cannot mask the map fault.
- [x] 1.2 Add host held renamed-steps/newer-tree reproduction with no-competing-tree control. Repeat grouped directory, initial all-load and markers; wait for installation, not request start.
- [x] 1.3 Record current failure output and fixture milestones in verify.md. Do not write Proof claims yet.

## 2. Own resource obligations

- [x] 2.1 Introduce framework-free coordinator beside project-stream with typed immutable snapshots and installed/failed/disposed completion outcomes. Test first load and single-resource success/failure before wiring UI.
- [x] 2.2 Implement independent desired/running/installed generations and pending scope union. Test trailing reads, coalescing, wider/narrower interleaving, grouped-directory all-or-none publication and caller completion after supersession.
- [x] 2.3 Preserve failed resource snapshots/stale status until covering recovery. Test tree success while markers remain failed, bounded failure behavior and Retry.
- [x] 2.4 Inject lost pending obligation and global-generation faults separately; observe each fail at the intended production-path assertion, restore, then add adjacent Proof comments from output.

## 3. Preserve sequenced installation and lifetimes

- [x] 3.0a Repair empty-history cursor boundary: ResumePoints permits safe integer -1, old invalid -1 fixture becomes -2, and explicit baseline intent distinguishes covered-empty replay from generic never-read -1. Prove actual gateway replay of event0 and refusal below -1; inject old >=0 boundary and record observed failure. Coordinate gateway test ownership with R7.

- [x] 3.0 Prove unknown-event reconnect and initial socket-registration races from ack-audit.md using held real API responses and actual outbound resume frames. Implement tree-anchor-before-unsequenced-resources bootstrap and explicit baseline subscription input using existing subscribe-then-resume; preserve no historical -1 replay and update first-connection semantics explicitly. Inject future-tree acknowledgment, hardcoded -1 instead of the baseline input and pre-anchor resource reads separately.
- [x] 3.1a Hold production pushB after recording while pushC overtakes it; require contiguous acknowledgment and bounded gap recovery, including a still-open socket receiving no later event. Inject observed-only max acknowledgment and prove the missed marker through replay/installed state.
- [x] 3.1 Forward event sequence through project-stream/SubscriptionHandlers. Track installed coverage and conservative acknowledgment across resource obligations; test bootstrap/full resync, replay duplicate, earlier failed markers plus later successful tree.
- [x] 3.2 Implement disposal and same-project API replacement; test held resolve/reject after departure cannot publish, stale, toast or acknowledge and callers terminate as disposed.
- [x] 3.3 Test StrictMode setup/cleanup/setup with distinct live second owner. Inject disposed-owner reuse/departure guard faults and watch their actual failures before Proof.

## 4. Adapt the existing host

- [x] 4.1 Replace old refresh generations with coordinator consumption in use-plan-read while retaining sameSteps, tree/draft/refusal/hover settlement and assembled ChartRead. Preserve columns/PlanLive contract.
- [x] 4.2 Route initial load, stream invalidations, tree/settings/dependency/undo/redo writes and Retry through the owner. Maintain mutation landed/refused completion and busy/focus sequencing when refresh fails.
- [x] 4.3 Route marker initial/read/write/refusal and peer paths through markers resource; remove its separate latestMarkerRead owner. Test marker-only network scope, refusal-after-peer-delete, pending overlap and old-project failure suppression.
- [x] 4.4 Remove URL-only readsInFlight from wbs-api and update old same-URL sharing tests to generation-scoped coordinator sharing. Inject the original map back and observe the real API lifetime overlap failure.
- [x] 4.5 Remove redundant stream/read ownership only after all callers and tests use the coordinator. Confirm exactly one active subscription and StrictMode ownership behavior.

## 5. Verify integration and proof quality

- [x] 5.1 Run focused coordinator/API/project-stream/host read/marker/chart/focus/draft suites and all frontend source/spec/e2e typechecks. Inspect every test oracle in the held-response window.
- [x] 5.2 Run real-browser peer edit and marker scenarios preserving editor node, typed value, selection and relevant installed output. Watch a missed row update/focus fault if any new render safeguard is introduced. At closeout, identify the exact browser cases and their observed revisions/output; composed transport/jsdom evidence and a generic green pixels job do not establish this scenario obligation.
- [x] 5.3 Complete mutation table: named fault, production call path, failing assertion/output, restoration command. Delete any check whose intended fault cannot be observed instead of inventing Proof.
- [x] 5.4 Freeze tracked tree and run full workspace gate plus complete Chromium gate on isolated owned ports; preserve incoming Auckland timezone tier. Record all skipped/unavailable checks explicitly.
- [x] 5.5a Independent review and OpenSpec validation, including rereview of replay recovery and stale physical socket callbacks.
- [x] 5.5b Reconcile integration and update queue/evidence after the required whole-gate outputs support completion. The original refactoring branch was squash-merged as cbad68af; HTTP migration and R10's checked slices have since landed, so their historical blanket blocker is obsolete. Record that merged disposition without inventing a branch-local gate, and keep any unresolved 5.2/5.4 evidence explicit before archival.

## 6. Independent review corrections

- [x] 6.1 Reproduce persistent resume denial and empty acknowledgment through actual ProjectPage callbacks; retain registered stream for bounded anchored recovery, prove next real reconnect uses its installed anchor, and fault epoch replacement.
- [x] 6.2 Reproduce stale physical close/open/resync/presence callbacks after replacement; capture socket epochs and prove each stale callback is inert by removing that boundary.
- [x] 6.3 Match HTTP/stream fixture null controls to initialize; hold recovery across another reconnect and prove its covering obligation cannot disappear.
- [x] 6.4 Run restored host/stream/HTTP regression, types/lint and independent rereview; parent retains full-gate ownership.
