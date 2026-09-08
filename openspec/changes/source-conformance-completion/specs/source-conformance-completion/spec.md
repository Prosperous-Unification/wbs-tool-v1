## ADDED Requirements

### Requirement: Closed store-family inventory

The shared conformance catalog SHALL enumerate projects, users, directory, capacity, priorityBands, calendarMarkers, eventLog, planEvents, steps, workItems, estimates, actuals, measures, progress, dependencies, subtrees and journal as seventeen transactional families, plus savedPlans and savedPlanCapture as two history families. The users family SHALL cover both UserStore and OidcIdentityStore when offered. Expected cases and registered kits SHALL be independently enumerated. Existing steps, estimates, directory and eventLog case IDs SHALL remain stable.

#### Scenario: A kit disappears from registration

- **WHEN** an offered family's kit is removed while its port and expected manifest remain
- **THEN** full certification SHALL fail with the missing family and case IDs, even when every remaining body passes

#### Scenario: A new port is not inventoried

- **WHEN** the transactional or history composition gains a port without a manifest entry
- **THEN** the conformance typecheck SHALL reject the missing family

### Requirement: Execution-specific certification

Certification SHALL distinguish declaration from execution and SHALL give every expected case a terminal passed, failed, not-offered or incomplete status. Passed SHALL require successful setup, all case assertions and teardown. Full certification SHALL reject missing or duplicate cases, unknown or duplicate exclusions, setup/cleanup failures and nonterminal cases. Focused execution SHALL identify its report as partial.

#### Scenario: Declared case body never runs

- **WHEN** a registered case body is not invoked
- **THEN** the report SHALL NOT label that case passed and full certification SHALL fail for incomplete execution

#### Scenario: Teardown fails after assertions pass

- **WHEN** a case's assertions succeed but its fixture cannot close
- **THEN** the case SHALL fail and the cleanup failure SHALL remain visible

### Requirement: Capability-specific offered contracts

Each source SHALL explicitly declare every family offered or absent. An offered family with known missing behavior SHALL name exact case exclusions, reasons and actual failing assertion evidence. Certification SHALL report only passed offered cases as certified and SHALL print exclusions and absent families separately. SQLite SHALL offer all nineteen families without behavioral exclusions. Memory SHALL preserve D29's permitted lag without excluding core staged-source, independent-history or portable-composition obligations.

#### Scenario: Accountless source

- **WHEN** a source offers plan behavior without accounts
- **THEN** its users family SHALL be reported absent and the harness SHALL NOT require fake account methods

#### Scenario: Existing memory exclusion becomes stale

- **WHEN** an excluded case passes against the source with its exclusion bypassed
- **THEN** that exclusion SHALL be removed before the source is certified

#### Scenario: Newly tested memory refusal differs

- **WHEN** a new actuals, measures or progress unknown-step case fails against memory
- **THEN** the exact observed mismatch SHALL be recorded as a case-specific gap or corrected in separately authorized work, and unrelated offered cases SHALL still execute

### Requirement: Reachable broken-source proofs

Every new or changed conformance check SHALL have a named fault applied through `brokenSource(source, fault)` to its actual shared case. The proof SHALL establish successful setup and entry into the fault's named phase before accepting failure at the relevant assertion. Atomicity faults SHALL occur inside the actual adapter transaction or staged write. A failure before the required phase SHALL NOT count as proof.

#### Scenario: Fault destroys setup instead of the guarantee

- **WHEN** a mutant loses a prototype method or throws before any intended write
- **THEN** the proof recorder SHALL classify setup or phase failure and SHALL NOT certify the intended assertion as breakable

#### Scenario: Partial subtree write escapes rollback

- **WHEN** the final satellite write fails after earlier subtree writes and atomic rollback is disabled
- **THEN** `subtrees.insertSubtree:late-failure` SHALL observe the escaped state through the ordinary source readers and fail its exact pre-call-state comparison

### Requirement: Projects, identity and configuration behavior

The shared cases SHALL observe project creation with its supplied steps, project-scoped updates, reader-specific open order, unique usernames, nullable account fields, issuer-and-subject OIDC identity and verified-email conflicts. Configuration cases SHALL observe capacity's project/team key and null removal, default and whole-project priority ladders, and calendar-marker date/creation/ID ordering and project-scoped writes.

#### Scenario: One actor opens another order

- **WHEN** one actor opens projects A and B at stamps 100 and 200 and another actor has a different access order
- **THEN** `projects.recordOpen:reader-order` SHALL observe B before A for the first actor and the second actor's unchanged independent order

#### Scenario: OIDC subject belongs to two issuers

- **WHEN** the same subject string is resolved under two distinct issuers with different unclaimed verified email addresses
- **THEN** `users.resolveOidcIdentity:issuer-subject` SHALL observe distinct identities while repeated resolution of the same issuer/subject retains its original account

#### Scenario: Capacity is cleared beside surviving keys

- **WHEN** capacity for one project/team key is set to null
- **THEN** `capacity.set:clear` SHALL observe that key absent and all other seeded project/team capacities unchanged

#### Scenario: Marker sort keys tie

- **WHEN** markers c, a and b share their literal date and creation instant
- **THEN** `calendarMarkers.listFor:total-order` SHALL return a, b and c in that order

### Requirement: Row and step-fact identity

The shared cases SHALL observe atomic work-item respacing, parent moves, deletion/promotion, refusal before partial field changes, and per-row frozen-number clearing. Estimate, actual, measure and progress cases SHALL observe replacement, key-specific removal and ownership transfer. Measures SHALL preserve metric as part of identity. Unknown-step refusal SHALL be checked where the port models it and reported according to source capabilities.

#### Scenario: Work-item patch contains an unknown team

- **WHEN** a patch changes the row's name and supplies an unknown team
- **THEN** `workItems.patch:refusal-atomic` SHALL observe the refusal and unchanged name and junctions after settlement

#### Scenario: One measure metric changes

- **WHEN** token_estimate, token_actual and hours_actual exist on one work-item/step pair and only one metric is replaced or removed
- **THEN** the measure key cases SHALL observe the other two metrics unchanged

#### Scenario: Facts move to another work item

- **WHEN** estimates, actuals, measures or progress are transferred by the relevant moveAll operation
- **THEN** the ownership cases SHALL observe every selected fact at the destination with its exact values/timestamps and no remaining source facts

### Requirement: Shared structural and directory state

The shared cases SHALL observe dependency pair idempotence, exact pair removal, incoming and outgoing removal for doomed work items, assignment-reader agreement and atomic team-patch refusal. Subtree insertion SHALL update every supplied satellite/removal collection, respaced sibling and reparented row in the same source-owned state visible to ordinary readers.

#### Scenario: Doomed rows have edges in both directions

- **WHEN** removeAllFor removes two rows with incoming and outgoing dependencies beside an unrelated edge
- **THEN** `dependencies.removeAllFor:touching-set` SHALL observe all touching edges gone and the unrelated edge unchanged

#### Scenario: Copied dependencies use disconnected storage

- **WHEN** a subtree copy includes dependencies but the mutant writes them to a different backing fixture
- **THEN** `subtrees.insertSubtree:complete-copy` SHALL fail through the ordinary dependency reader

### Requirement: Journal and event retention behavior

The shared cases SHALL observe atomic journal-entry/history append, account-specific redo clearing and journal depth independently of plan-event retention. They SHALL observe flip/restamp/discard preconditions and state, plan-event filters and strict retention cutoffs. Event-log sequence allocation SHALL remain monotonic after retained rows become empty.

#### Scenario: Pruning leaves no retained event-log rows

- **WHEN** sequences 0 and 1 are recorded, pruneBeyond(0) removes retained rows and another event is appended
- **THEN** `eventLog.pruneBeyond:empty-sequence` SHALL observe an empty range before append and sequence 2 on the new event

#### Scenario: Plan-event timestamp equals the cutoff

- **WHEN** events at 99, 100 and 101 are pruned with cutoff 100
- **THEN** `planEvents.pruneOlderThan:strict-cutoff` SHALL observe one removal, events 100 and 101 retained and the separate journal sentinel unchanged

#### Scenario: History insert fails after journal insertion starts

- **WHEN** the plan-event insert fails inside journal.append after its journal write
- **THEN** `journal.append:history-atomic` SHALL observe neither entry nor event after rejection

### Requirement: Saved-plan write and ownership evidence

The savedPlans kit SHALL observe exact input/schedule bytes and metadata, UTF-8 byte accounting, nullable creator identity, creator display name, project ownership and unknown-touch outcomes. Quota refusal and late body-write failure SHALL leave no partial saved plan. Competing writes SHALL NOT both consume the same final quota slot.

#### Scenario: Multibyte body is written

- **WHEN** a saved input or schedule contains multibyte text
- **THEN** `savedPlans.write:bytes-and-bodies` SHALL observe exact stored bytes/hash and byte accounting based on UTF-8 bytes rather than string length

#### Scenario: Rival write arrives during quota check

- **WHEN** the first write holds its actual quota-check phase and a rival attempts the final available slot
- **THEN** `savedPlans.write:quota-window` SHALL observe at most one accepted plan and the declared adapter-specific serialization or immediate-busy outcome

#### Scenario: Schedule body write fails late

- **WHEN** schedule-body insertion fails after header and input-body writes have begun
- **THEN** `savedPlans.write:late-body-failure` SHALL observe no header or input body remaining after rejection

### Requirement: Coherent and detached saved capture

The savedPlanCapture kit SHALL observe all seventeen PlanInputReads fields, including unassigned people, capacity-only teams and global directories, and null for an absent project. A capture SHALL represent one read epoch and SHALL NOT expose mutable backing arrays to its caller.

#### Scenario: Directory changes during capture

- **WHEN** capture is held after its first snapshot read while an independent writer successfully renames a tag and changes membership
- **THEN** `savedPlanCapture.readPlanInput:coherent-interleave` SHALL observe the complete before-state in that capture and the complete after-state in the next capture

#### Scenario: Caller mutates a captured collection

- **WHEN** a caller mutates arrays in a returned capture
- **THEN** `savedPlanCapture.readPlanInput:detached` SHALL observe the original source contents on the next independent read

### Requirement: Independent-history mechanism certification

Both sources SHALL prove successfully written saved plans survive command-batch commit and rollback. SQLite SHALL declare immediate-busy admission and SHALL prove a history attempt settles snapshot_busy while a conflicting write batch remains held. Staged memory SHALL declare independent-write admission and SHALL prove a successful interleaved history write survives either settlement. A busy or refused attempt SHALL NOT count as a successful-save survival proof.

#### Scenario: Memory writes history during a staged batch

- **WHEN** an interleaved memory history write returns written and the batch subsequently commits or rolls back
- **THEN** `history.batch:interleaved-success-survives` SHALL read back that exact saved ID after each settlement

#### Scenario: SQLite reports lock contention

- **WHEN** the SQLite history writer attempts a write while another command connection holds its write transaction
- **THEN** `history.batch:busy-does-not-wait` SHALL observe snapshot_busy before the held batch is released, and separate successful-save cases SHALL still prove durability across both settlements
