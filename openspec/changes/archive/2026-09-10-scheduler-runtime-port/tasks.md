Execute one checkbox per reviewed TDD slice. Preconditions: the two-schedule/cue
interfaces inspected at `aca7a5c9` have landed via PR #354 or a successor equivalent
(they are not yet on integration base `main` `14cc7367`); core neutral contracts/runtime
tasks 2.2b–2.2b.4 completed. Code remains at the
pre-core-move paths in design; the extraction resumes afterward. Record exact landing SHA
and pre-existing dirt. Never overwrite the active optimizer feature's edits.

## 1. Port and adapters

- [x] 1.1 **Characterize selection, then introduce the value port.** Add core
      `ports/scheduler.ts` and runtime-portable `scheduler.test.ts`; use literal fixtures
      with distinct Fast/PRI/time outputs and nonempty capacity/reach/deadlines. Implement
      `createScheduler` with one optional two-reader adapter. Cases: all selections,
      enabled/disabled, absent adapter, every current variant state, ready-with-null,
      unexpected throw and cycle. Fault: remove missing-adapter guard, call the read and
      assert unavailable plus zero Fast invocations; drop the seventh argument and assert
      the literal deadline map at the injected domain call. Run core/runtime-portable
      lint, typecheck and tests, including spec compilation.
- [x] 1.2 **Move the synchronous hash without changing its bytes.** Inventory every
      `scheduleInputHash` import; move it to the temporary repository file from S2 and
      retarget all callers. Keep canonicalization and corpus in domain. Tests use literal
      hashes captured from unchanged input and an existing-key cache row; deliberately
      omit reach/deadlines from hashing and observe a wrong addressed row/hash. Run domain,
      contracts and be-01 relevant tests/typecheck; verify domain imports no node:crypto.
      Do not increment the semantic version for a file move.
- [x] 1.3 **Add nonadmitting captured cache reads.** Add
      `repository/captured-optimization-reader.db.test.ts` against real cache rows and
      generation/slot/queue tables. Exercise ready, pending, failed, corrupt, infeasible
      and missing results for exact/mismatched keys. Inject a call to `readPlan` for the
      miss and assert a forbidden state-table change at return; inject enabled:false reuse
      for ready and assert the missing schedule. The oracle must see a real cached ready
      schedule and a real admission-capable miss. No test may stub both away.

## 2. Live read and publication

- [x] 2.1 **Wire the scheduler through current services.** Change work-item options and
      composition, preserve one source of ProjectService availability, and use the port
      in tree. Keep current optimized-plan-read, annotation, availability, cycle and
      fractional-schedule suites. Add a real service unavailable fixture; fault is omitted
      refusal propagation, assertion is the unavailable arm with no Fast dates. Hold a
      fake solve unresolved and prove the live read settles before releasing it, using a
      controlled completion signal rather than a latency threshold.
- [x] 2.2 **Bind the 409 contract.** Extend exact getWorkItems/exportProject reply shapes,
      shared refusals and both binders. Mounted tests call GET and JSON/Markdown export
      on a directly stored optimized project with no adapter; assert status/body/media
      type and unchanged successful exports. Fault: remove each unavailable mapping,
      observe its mounted response differ from the required 409, not merely unit output.
      Run contracts, generated-client/MCP-tool and route-bijection tests; retain settings
      PATCH's optimizer_unavailable spelling. Frontend renders the named message through
      its resource-failure path and creates no export download on refusal.
- [x] 2.3 **Make committed-write publication explicit.** Add plan_unavailable to
      ProjectEvent, implement announceTree's branch, and narrow resourcesFor to tree.
      Drive a real runner mutation, commit, durable event and peer coordinator refetch;
      assert stored mutation, successful response, exactly one invalidation, typed read
      failure and zero Fast tree_replaced events. Fault: publish Fast instead; assert the
      actual durable event before allowing peer read. Refused batch still emits nothing.
      Add a browser case for visible failure over last-installed dates; inject suppressed
      failure rendering and observe it in the failed-refetch window, not after recovery.

## 3. Detached captures

- [x] 3.1 **Expose captured canonical input without scheduling.** Extract
      scheduleInputOfCaptured from saved-plan-schedule.ts and require Scheduler at the
      SavedPlanService construction sites. Compare live and captured inputs against
      literal seven-field fixtures, not only each other. Preserve read-connection-closed
      at scheduler-entry assertions; deliberately move scheduling inside capture and
      observe the open reader at that exact instant. Run saved-plan capture/deadline tests.
- [x] 3.2 **Store the actual selected schedule or named absence.** Apply S4's complete
      table to save/current and parameterize buildScheduleBody's algorithm identity.
      Add selected-ready schedules observably different from Fast, all absence states,
      disabled preference, no-adapter and zero-work cases. Faults: store Fast for ready,
      hardcode Fast algorithmId, admit a solve on save. Assert stored schedule bytes and
      both identity locations; assert real slot/queue/generation state at save return.
      Keep history atomicity, quota, busy, retry, corruption and immutable-read suites.
      Replace the historical-read scheduler with a throwing fake and read/diff old history
      successfully; deliberately recompute and observe that specific throw.

## 4. Integration and evidence

- [x] 4.1 **Verify production paths and hand back to core.** Run touched lint/typecheck
      and tests plus existing optimization process/database suites without altering host
      authority. Run the complete `bin/h2puni-gate.sh` on its configured host/frozen tree;
      run the whole browser suite with owned, safe ports
      (`CI=1 E2E_PORT_SHIFT=1900 bun run e2e` only after confirming 5000/5100/6100 are free).
      Record unavailable checks rather
      than treating absent tools/host access as passing. Write verify.md from fresh output:
      revision, commands, selection table results, each injected fault/assertion/window,
      restored-green output and remaining limitations. Write adjacent Proof comments only
      from observed failures. Resume core 2.2c; no claim that this packet implements the
      rest of core or runs a non-Bun composition by itself.
