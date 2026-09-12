# Gateway Request Deadlines Specification

## Purpose

Bound backend and gateway dependency requests through headers, bodies and backoff while preserving committed edits and modeled gateway outcomes.

## Requirements

### Requirement: One overall request budget

Each push, forward and resume operation SHALL have injected positive finite attempt and overall budgets. All attempts, backoffs and response-body reads MUST fit one immutable overall deadline; exhausting the retry count SHALL NOT be the only termination mechanism.

#### Scenario: Hung first request expires without retries

- **WHEN** a request with zero retries never supplies headers
- **THEN** it terminates at its overall deadline, aborts the transport and starts no later attempt

#### Scenario: Retries cannot extend the overall deadline

- **WHEN** a second attempt starts with less overall time remaining than its attempt budget
- **THEN** it receives only the remaining time and terminates at overall expiry

### Requirement: Cancellation covers body and backoff

The active transport SHALL receive cancellation throughout headers and body consumption. Overall or caller cancellation MUST interrupt backoff, prevent further attempts and release owned timers/listeners.

#### Scenario: Response headers arrive but body stalls

- **WHEN** a success JSON or permanent-error diagnostic body stops supplying bytes
- **THEN** the operation and active body transport terminate at the applicable deadline

#### Scenario: Caller leaves during backoff

- **WHEN** the caller cancels while retry delay is pending
- **THEN** delay ends without starting another request and cancellation is not retried as a transient failure

### Requirement: Retry only modeled transient failures

Push retry behavior SHALL preserve its existing status and additional-retry-count semantics while bounding modeled network failures. Unexpected failures and malformed trusted response data MUST propagate explicitly rather than become successful defaults or automatic retries.

#### Scenario: Transient network failure is bounded

- **WHEN** a modeled transient network failure occurs with retry budget remaining
- **THEN** another attempt may start only within the remaining overall budget using the same push payload

#### Scenario: Unknown dependency failure remains visible

- **WHEN** transport execution or response parsing produces an unmodeled error
- **THEN** the client propagates that error rather than consuming retries or substituting an empty reply

### Requirement: Delivery cannot refuse a committed edit

Gateway delivery SHALL run outside the database write lock. Its failure or cancellation MUST preserve the durable event and SHALL NOT report the already-committed edit as refused. This change MUST NOT introduce an unbounded per-edit background task.

#### Scenario: Delivery stalls after event commit

- **WHEN** push is pending until its deadline
- **THEN** another write-lock turn can enter, the committed event remains replayable and delivery failure is reported without reversing command success

### Requirement: Gateway callers retain modeled outcomes

Live gateway connections SHALL retain existing forward backend-unavailable and resume-denied/ack outcomes when dependency requests expire. Resume MUST reject non-success HTTP responses before accepting a success body. Connection closure SHALL cancel its requests without sending late frames.

#### Scenario: Unavailable backend returns plausible resume body

- **WHEN** resume receives503 with JSON otherwise matching a success schema
- **THEN** the request is unavailable rather than successful replay

#### Scenario: Connection remains usable after timeout

- **WHEN** a forward or resume request expires on a live connection
- **THEN** its modeled failure is sent and a subsequent ping still receives its response

#### Scenario: Closed connection cancels pending request

- **WHEN** the connection closes during a dependency request
- **THEN** transport cancellation occurs and no late reply is sent to that connection
