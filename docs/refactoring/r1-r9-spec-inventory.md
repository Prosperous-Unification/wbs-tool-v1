# R1–R9 spec inventory

Captured from `main` at `5516d453` on 2026-09-08, before the first R1–R9 delta
was synced. The main spec tree contained only `http-endpoint-port` and
`wbs-table-modules`; none of the nine capability names below existed there.

This is the preservation oracle for sequential syncs. A requirement owns the
indented scenarios that follow it.

## Shared capability: authentication

### `account-store-failures`

- `Account resolution failures remain server failures`
  - `Password account lookup fails`
  - `OIDC account resolution fails`
  - `Invalid credentials versus unavailable verifier`

### `login-admission`

- `Password login reserves bounded verification capacity`
  - `Concurrent logins for one account or IP`
  - `Distinct accounts share a cap`
  - `Invalid composition limit`
- `Login reservations end with their attempts`
  - `Attempt settles`
  - `Window expires during pending work`

## Shared capability: realtime

### `websocket-ingress`

- `Gateway validates client frames before dispatch`
  - `Malformed decoded value`
  - `Malformed resume point`
  - `Malformed control carrying a message`
- `Refused input does not disable a connection`
  - `Ping after refusal`
  - `Valid forwarding and resume`
  - `JSON whitespace and quoted commands`

### `scoped-presence`

- `Presence changes identify affected projects`
  - `Move between projects`
  - `Repeated or stale membership instruction`
  - `Rejoin an existing connection id`
- `Initial and reset rosters are connection-specific`
  - `Newcomer among many projects`
  - `Current-project unsubscribe`
- `Scoped presence preserves connection identity and isolation`
  - `One of two tabs disconnects`
  - `Verification races`

## Distinct capabilities

### `team-removal-revisions`

- `Removing a team revises every affected work item`
  - `Secondary team removal`
  - `First team removal`
  - `Refused or repeated removal`
- `Undo observes removal of any team`
  - `Undo after secondary team removal`

### `project-assignment-reads`

- `Plan assignment projections are scoped to the project`
  - `Tiny project among unrelated projects`
- `A single work-item assignment read is bounded`
  - `Assignment write among unrelated projects`
- `Store projections preserve existing consumers`
  - `Different projects in the memory fixture`

### `bounded-replay-sweep`

- `Subscription selection performs bounded work`
  - `Large subscription populations`
- `Rotation preserves expiry and replay semantics`
  - `Deleted subscriptions during a lap`
  - `Expired replay range`

### `gateway-request-deadlines`

- `One overall request budget`
  - `Hung first request expires without retries`
  - `Retries cannot extend the overall deadline`
- `Cancellation covers body and backoff`
  - `Response headers arrive but body stalls`
  - `Caller leaves during backoff`
- `Retry only modeled transient failures`
  - `Transient network failure is bounded`
  - `Unknown dependency failure remains visible`
- `Delivery cannot refuse a committed edit`
  - `Delivery stalls after event commit`
- `Gateway callers retain modeled outcomes`
  - `Unavailable backend returns plausible resume body`
  - `Connection remains usable after timeout`
  - `Closed connection cancels pending request`

### `plan-refresh`

- `Every invalidation reaches a covering outcome`
  - `A newer tree change arrives during an old tree read`
  - `Repeated invalidations coalesce without disappearing`
- `Resources retain independent installation authority`
  - `A renamed step finishes after a newer tree read`
  - `Marker reads do not replace schedule state`
- `Failures remain visible until their resources recover`
  - `Tree recovery cannot conceal failed markers`
  - `A committed edit has a failed refresh`
- `Stream acknowledgment reflects installed coverage`
  - `An earlier resource failure blocks later acknowledgment`
  - `Full resync does not acknowledge a partial load`
  - `A newer tree response precedes an unseen marker event`
  - `Baseline closes the initial subscription registration gap`
  - `A later live event overtakes an earlier event`
- `Read ownership ends with its project and API lifetime`
  - `Old requests settle after departure`
  - `StrictMode remount establishes a live owner`
- `Editing and assembled chart state are preserved`
  - `A peer update arrives during a local draft`
- `Empty-history baselines can replay the first event`
  - `The first event occurs before baseline subscription registers`
  - `A cursor lies below the modeled sentinel`
- `Replay recovery retains one registered stream`
  - `Every replay attempt is refused`
  - `Reconnect occurs during held recovery`
- `Physical socket callbacks expire with their socket`
  - `Old callbacks arrive after replacement synchronization`
