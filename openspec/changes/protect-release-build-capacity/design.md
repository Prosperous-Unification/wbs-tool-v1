## Admission boundary

The publish process re-executes itself under a non-blocking `flock` before it
reads capacity or opens a Dagger connection. The same lock path is the contract
for h2puni's full repository gate. A missing `flock`, unreadable capacity input,
or occupied lock refuses the operation.

Inside the lock, admission requires all three facts:

- `MemAvailable` is at least 8 GiB;
- combined `/tmp` and `/dev/shm` use is at most 25% of their combined capacity;
- one-minute load is at most the online CPU count.

The snapshot and every refusal print measured values without secrets.

## Bounded engine

The release connects to a named v0.21.8 engine bound only to host loopback. Its
Docker contract is 8 GiB memory with no swap expansion, 6 CPUs, and 2,048 PIDs.
The persistent Dagger volume keeps disk cache; stopping the container releases
resident memory. An existing container whose image, port, or resource contract
does not match is refused, not silently reused or destructively replaced.

Engine stop is in the outer `finally`, after both successful publishes and
errors. A stop failure is terminal because reporting success while leaving the
engine resident recreates the incident.

## Heavy gate contract

The repository supplies a gate entrypoint that acquires the same lock before
running the uncached Nx gate. Queue workers and the runbook use that entrypoint;
the publish cannot overlap a conforming gate, and two publishes cannot overlap.
CI does not share the host and does not use this lock.
