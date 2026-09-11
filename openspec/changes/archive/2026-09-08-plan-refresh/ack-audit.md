# R1 acknowledgment race audit

Read-only source audit against merged362c29a8. No runtime reproduction or tests performed; the timelines below are source-derived hypotheses requiring held-response proof before implementation is considered verified.

## What the stream actually does

project-stream.ts receive (~233–239) does NOT compare incoming frame.seq with sinceSeq. Any matching numeric-sequence data frame invokes onChange, even after seen() advanced beyond it. A late live B frame is therefore not dropped locally. seen() (~299) only takes max into sinceSeq. The loss occurs at replay selection: on the next open, the stream sends resume_points with sinceSeq; ReplayBuffer.since filters seq > sinceSeq and event-log rangeSince queries seq > sinceSeq.

ProjectPage's subscription factory (~466) fixes sinceSeq:-1. On a first socket open with negative sinceSeq, subscribeToProject sends subscribe and calls settle without requesting resume (~269–278). usePlanRead starts initial full refresh in one effect, marker read in another, and subscribes in another. These network operations overlap; calling openSocket does not prove the server has registered the subscription. The tree refresh ends by stream.current?.seen(tree.seq) (~642), independently of marker publication.

## Two concrete fault timelines

Established socket: marker GET captures listA and is held. Marker B commits, but its live frame is held. A tree GET captures seqB, publishes and calls seen(B). The held marker GET publishes listA. Disconnect before delivering live B. Reconnect sends resume from B; both replay sources exclude B by their strict greater-than predicate. No new marker invalidation exists, and the stale list can persist indefinitely without another event. Delivering B on the original socket would repair it, so a proof that merely delays and then delivers B is the wrong negative.

Initial load: start marker GET, capture listA; hold socket registration. Commit B; start/complete tree snapshot at seqB and finish the other initial resources, then release markerA. If the stream object exists, tree refresh can store seen(B) even before onOpen, and onOpen resumes only >B. Alternatively the socket opened with -1 before any read completed, skipped replay, and B occurred before effective server registration; seen(B) later does not request a replay on that open socket. Both variants can leave markerA installed with no event to repair it.

The draft's previous rule about preceding OBSERVED obligations blocks known markerB but cannot block this unobservedB. Its caveat about non-atomic endpoints accurately limits claims but does not repair the actual reconnect gap. Therefore the bootstrap and future-tree-sequence rule need strengthening.

## Required refinement

Take a tree snapshot first to establish anchor A; only after its response may the initial unsequenced steps/directory/markers reads start. Earlier speculative reads, if any, cannot count as the baseline resource coverage. This guarantees reads used for bootstrap happen after anchor A; it does not claim they share one server transaction or cannot include later changes.

Prefer the existing subscribe-then-resume mechanism with an explicit baseline input to the table subscription factory. Replace ProjectPage's hardcoded sinceSeq:-1 with the supplied stable anchor. Minimal ordering: obtain tree anchor A; fetch/install the unsequenced baseline resources after A; create the subscription with sinceSeq:A. The existing onOpen now sends subscribe followed by resume(A), closing the entire interval between A and registration. An event B after A cannot be silently skipped merely because one resource read finished before it. This delays initial subscription/presence until baseline readiness; record that intentional lifecycle trade in the change, rather than claiming the old immediate first-connection semantics are unchanged. If preserving early presence is required, an explicit current-socket baseline replay operation is the alternative, but do not add it by default. Do not repeatedly recreate the subscription for each later tree seq; the bootstrap anchor belongs to one project/API lifetime or deliberate resync epoch.

After establishment, only covered sequenced event obligations can advance above A. Arbitrary future tree response seqB is never an acknowledgment candidate. Initial baseline failure leaves loading/failure visible and does not create a falsely covered subscription; Retry completes/restarts valid baseline coverage. Resume denial requires anchored full resync, with explicit epoch/subscription replacement and teardown semantics.

Additional source finding: live delivery is NOT guaranteed to arrive in sequence order. GatewayBroadcaster.publish records under the write lock and releases it before awaiting push.push; two publishers can therefore record B then C while a held/retrying pushB lets pushC reach the gateway first. event-log.ts recordEvent allocates contiguous sequences PER SUBSCRIPTION using event_sequencer(subscription,next_seq), starting at zero. The earlier draft's caveat that gaps may belong to other scopes was wrong for this implementation and is removed. Reconnect replay filters strictly greater than the cursor.

Therefore acknowledgment requires contiguous coverage from the baseline, not only all OBSERVED obligations. Receiving C with unseen predecessor B cannot move the cursor past B. A gap must also initiate recovery; merely refusing to acknowledge while keeping the socket open would leave missed markerB stale indefinitely. Prefer the existing full-resync path: acquire a new tree anchor, read unsequenced resources after it, install, then establish subscription/replay from that covered anchor. A scoped live C read may proceed, but it does not satisfy the unknown gap's all-resource obligation. An explicit replay request from the covered cursor is another possible implementation if the existing stream seam can express it without introducing a second recovery owner. Choose one bounded recovery path; do not run overlapping unbounded full reload loops for every high frame.

The old no-baseline first-connection contract can remain for generic callers that still pass -1, but the table now supplies a covered anchor and exercises existing subscribe→resume. Test both explicitly. Transport live status and installed freshness remain different readings. The stronger bootstrap/gap guarantees are R1's sequenced invalidation scope, not a backend delivery serialization change.

## Required held-response proofs

Use real httpProjectApi and actual subscribeToProject with the existing injectable socket harness; feed responses/events through production boundaries. Capture actual outbound resume JSON. The decisive assertions require installed marker listB and a safe resume cursor, not just onChange call counts.

1. Established owner at A: hold markerA response and live markerB frame; return tree seqB, release markerA, disconnect, reconnect. Assert resume cursor remains A until B has been replayed and its marker read installed. Simulate strict >cursor replay from a journal containing B, then require B appears without C. Inject seen(tree.seq) to observe failure in the replay/window; do not deliver delayed B independently afterward.
2. Bootstrap registration gap: hold socket registration, anchor treeA, commit B before registration, then finish post-anchor resource reads and register socket. Some post-anchor reads may already include B, but explicitly hold one captured before B so replay has observable work. Require baseline replay from A and B installation. Inject starting the table subscription with hardcoded -1 instead of anchor A; require the stale resource, not a missing implementation-spy call, to fail.
3. Bootstrap bad ordering: marker read captures A before anchor treeB, then finishes after treeB. Inject parallel unsequenced reads before the anchor and require it cannot establish B as covered. The failure must concern markerB visibility/resume cursor with no later event, not merely promise order.
4. Baseline failure/disposal: if one post-anchor resource fails or owner departs, baseline subscription must not claim coverage. Retry performs new valid anchored coverage or finishes the existing still-valid obligations, with explicit tested semantics; no old owner may establish the baseline subscription.

Each is pending. Write Proof only from the actual failure output after implementation/fault injection.

5. Out-of-order publisher proof: hold production pushB after durable record, allow pushC to reach the stream, then disconnect before B. Show outbound resume cannot exceed A until B is installed or an anchored all-resource recovery covers the gap. Inject observed-only max acknowledgment and require markerB remains stale under strict >cursor replay; separately keep the socket open and drop B to prove gap recovery does not depend on another event or reconnect. This is pending and must be bounded, with no new backend lock around network delivery.

## Empty-history cursor disposition — approved by parent

Allow exactly the modeled sentinel -1 in ResumePoints: safe integers from -1 through MAX_SAFE_INTEGER. Backend ReplayOrchestrator already accepts -1 and event-log.latestSeq returns it before first event0, so this repairs the cross-tier contract. Preserve rejection of -2, fractions, non-finite/unsafe values, arrays and malformed frames. Update the existing R4 negative fixture from -1 to -2 and record the intentional correction/proof under R1. Do not clamp an empty baseline to0.

Add explicit resume-baseline intent to subscription options so a covered-empty baseline (-1 with resume intent) requests replay, while generic never-read callers (-1 without that intent) retain their existing subscribe-without-history behavior. The numeric cursor alone cannot represent both meanings. A normal nonnegative baseline still uses existing subscribe-then-resume ordering.

Required production proof: actual gateway ingress accepts explicit resume_points at -1 and the backend can replay first event0; below-sentinel -2 and all other existing malformed categories remain refused, with connection usable afterward. Inject the old >=0 bound and watch the empty-baseline browser/stream integration fail at the real socket boundary. Also hold registration across the first event and require event0's marker state to install without event1. Preserve generic -1 no-resume tests and add covered-empty explicit-resume tests.

Implementation ownership includes libs/contracts/src/ws.ts and directly relevant tests, but no tracked edit is allowed until release. Coordinate gateway integration tests with R7; do not concurrently edit gw app wiring. Root HTTP work uses separate contracts/http files.
