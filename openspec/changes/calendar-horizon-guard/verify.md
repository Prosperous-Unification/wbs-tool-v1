# Verification

Pending the h2puni-only gates required by the repository and queue worker
contract.

| Guard | Injected fault | Expected witness | Result |
| --- | --- | --- | --- |
| `addWorkdays` range classification | remove the invalid-Date check | typed-error unit assertion | pending |
| command transaction preflight | remove the `calendar_range` branch | mounted command returns 200 and read reports the stranded state | pending |
