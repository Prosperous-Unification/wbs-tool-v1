# Verification

Verified on h2puni at `4aea80ba62f0c40a7c972e642e44ce6be956fa4c`.

- Focused domain and mounted-controller run: **116 passed, 0 failed**, 495
  assertions.
- `domain:typecheck`, `be-01:typecheck`, and `fe-01:typecheck`: passed.
- Prettier check over every changed path: passed after the formatting commit.
- OpenSpec 1.3.0 `validate --all --json`: **70 passed, 0 failed**.

| Guard                              | Injected fault                             | Expected witness                                                | Result                                                                  |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `addWorkdays` range classification | remove the invalid-Date check              | typed-error unit assertion                                      | **failed as required**: constructor `RangeError`, message `Invalid Date` |
| command transaction preflight      | make the `calendar_range` branch unreachable | mounted command returns 200 and read reports the stranded state | **failed as required**: expected 422, received 200                       |
