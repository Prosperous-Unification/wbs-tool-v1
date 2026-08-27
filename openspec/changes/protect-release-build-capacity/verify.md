# Verification

## Failure proofs

| Check                    | Fault injected                                 | Test that observed the failure                        | Result                                            |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| Capacity and engine IO   | Production reader and validator exports absent | `readBuildCapacity` / `assertEngineContract`          | Watched RED at `1c656aff`: missing named export   |
| Unsafe capacity ordering | Available memory one byte below 8 GiB          | `runAdmittedPublish`                                  | Engine and publish call list stayed empty         |
| Existing-engine drift    | Docker inspect reports no memory ceiling       | `assertEngineContract` through production control     | Refused before `docker start`                     |
| Heavy-work exclusion     | Real child holds the same `flock`              | `with-heavy-lock` contention case                     | Watched RED at `950513a7`: entrypoint absent      |
| Engine cleanup           | Publish throws; stop throws                    | `runEngineLifecycle` success/error/stop-failure cases | Stop always attempted; stop failure remains fatal |

## Gate

| Command                                                     | Result                                            |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `bun test tools/tool-dagger/src/main.test.ts`               | 23 passed, 0 failed at `fd53e76b`                 |
| `nx run-many -t test lint typecheck --projects=tool-dagger` | 37 passed; lint and typecheck green at `1118494b` |
| `prettier --check` on the changed TypeScript                | Green at `1118494b`                               |
| `bin/h2puni-gate.sh`                                       | 23 projects green at `b618f2da`; lock held        |

All builds and autotests ran on h2puni; none ran on h1claw.
