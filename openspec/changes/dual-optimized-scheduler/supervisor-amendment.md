# Host-owned solver supervisor amendment

This amendment supersedes every earlier sentence in this change that places a
per-solve systemd scope, writable cgroup subtree, Docker socket, or parent-death
relationship inside `be-01`. The canonical request, SQLite admission/token
fence, cache identity, and in-process CP-SAT budget remain unchanged.

## Measured deployment constraint

The deployed backend image has no `systemd-run`; its cgroup-v2 mount is private
and read-only, and `be-01` mounts only `/data`. Mounting the host Docker socket,
systemd bus, or a writable host cgroup subtree into an internet-reachable
backend would grant authority far beyond one bounded solver. On h2puni the
`puni1` user manager is running, its transient units can reach the rootful
Docker daemon through the existing `docker` group, and Docker uses systemd
cgroup v2. Systemd supervision and Docker's per-container limits are the
maintained primitives; the custom code is only their narrow protocol adapter.

## Boundary and authority

1. A lingering host user service named `wbs-solver-supervisor`, installed with
   `Restart=always` and a short `RestartSec`, owns one Unix socket under its
   systemd `%t/wbs-solver/` runtime directory. Backend containers bind-mount
   that directory, not the socket inode, so reconnects see a recreated socket.
   They never receive `/var/run/docker.sock`, a systemd bus, or a writable
   cgroup path.
2. The supervisor is the only process that invokes Docker. It accepts no shell
   text. Every Docker command is an argv array assembled from validated typed
   fields and fixed flags.
3. On accept, the supervisor reads `SO_PEERCRED`, resolves the peer's host PID
   through `/proc/<pid>/cgroup` to a Docker container, and requires that id to
   equal the claimed caller id. It then inspects that live container and
   accepts only configured backend container-name patterns. A claimed id for
   another live backend is rejected. The supervisor selects the caller's image
   itself; a caller cannot choose an image, entrypoint, mount, network,
   environment variable, capability, or Docker option.
4. Host configuration caps a request at 512 MiB, 2 search workers, and 128 PIDs
   per child, plus 16 live managed containers globally. Deployment may lower
   these values; a caller cannot raise them. Out-of-range work is rejected
   before `docker create`. SQLite remains the functional 4/16 admission
   authority; the host cap contains a compromised backend.
5. Each solve gets one container from the caller's exact digest-pinned image,
   labelled `wbs-managed-solver=true` plus attempt token, caller id, project id,
   and objective. It has no network, no inherited environment or secrets, a
   read-only root with a 64 MiB `/tmp` tmpfs, all capabilities dropped,
   `no-new-privileges`, `--init`, no restart policy, and the requested limits.
   The fixed command is `wbs-solver-launcher --attempt-token <token>
   --child-deadline-epoch-ms <childDeadlineAt> --search-workers <count>
   --memory-limit-mb <limit>`.
6. Every list, kill, or removal first filters on
   `wbs-managed-solver=true` and then uses one exact container id; broad prune
   is forbidden. Termination is ordered `docker kill`, `docker wait`, `docker
   inspect`, terminal-frame delivery, then `docker rm`. Removal never precedes
   evidence capture. On service start the supervisor applies this sequence to
   every managed orphan before listening.

The dev source container is not a solver image. Dev uses a host-configured
digest-pinned solver image whose installed `solverVersion` matches the contract
reported by the backend; only the peer-derived `wbs-dev-src` caller may use
that mapping. An exact commit match is required for prod colours. Dev rebuilds
the mapping when `libs/solver-py/**`, its lockfile, or solver packaging changes;
unrelated source commits retain the compatible mapping. The mapping is host
deployment state, never a field the caller may override.

## One connection, one attempt

The Unix stream is newline-framed, bounded, and never multiplexed. The one
`start` frame contains `protocolVersion`, claimed caller id, project id,
objective, attempt token, absolute `childDeadlineAt`, search-worker count,
memory limit, and the deterministic solver request. Before creating a
container, the supervisor validates the whole frame, `SO_PEERCRED` identity,
2 MiB total input ceiling, host resource bounds, and a positive remaining
deadline. Unknown fields and duplicate frames are protocol errors.

After `docker create`, attach, and start, the supervisor returns `started` with
the container's host init PID. The coordinator presents that PID to the
existing SQLite bind CAS, then sends exactly one `bound` or `abort` frame. Only
`bound` makes the supervisor write `bound\n` followed by the exact request line
to the launcher's stdin. `abort`, bind timeout, protocol error, socket EOF, or
an explicit kill frame starts the ordered termination sequence. The solver
therefore cannot begin before the counted `starting` row becomes `running`.

The supervisor relays base64 payload frames no larger than 64 KiB, capped at
2 MiB stdout and 256 KiB stderr per attempt, then one terminal frame containing
exit code, deadline-kill flag, and Docker's recorded `OOMKilled` boolean.
Output overflow kills the attempt and becomes `invalid-output`. Cancellation
requests a kill and awaits the terminal frame before releasing the SQLite row.
Socket EOF makes the supervisor kill the attempt. If a coordinator receives
EOF without a terminal frame, it records `internal-error` but keeps the slot
counted until the child deadline plus reclaim margin; it never releases
capacity while a container may remain live. This replaces
`PR_SET_PDEATHSIG`, which cannot cross the Docker boundary.

## External ceilings and classification

- Docker `--memory=<limit>m` and equal memory-swap are the RSS authority.
  `RLIMIT_AS` remains the loose portable backstop already installed.
- For each container the supervisor creates a transient systemd user timer
  which runs `docker kill <exact-id>` at the frame's `childDeadlineAt`, never
  at `admittedDeadlineAt`. Systemd retains that kill if the supervisor process
  restarts. CP-SAT's own limit and launcher alarm remain the partial-result
  path.
- `OOMKilled=true` is the only generic native-process evidence classified
  `oom`; a supervisor deadline kill is `timeout`; a non-zero exit with neither
  is `internal-error`. Exit text never guesses the class.
- `admittedDeadlineAt` remains 15 seconds later than `childDeadlineAt`, giving
  wait/inspect/report a full margin before SQLite may re-admit capacity.

The process proof counts managed containers, not process names hidden by a
private namespace. At every sample, live managed containers must be no greater
than all unreleased slot rows (`starting` plus `running`), hence no greater than
4 per project or 16 globally. After `bound` is forwarded, solving state also
corresponds to a `running` row.

## Deployment and proof order

1. Land the protocol codec and command builder with rejection tests for unknown
   fields, oversize input/output, invalid ids, spent deadlines, spoofed live
   caller ids, requests above host limits, and attempts to choose authority.
2. Land a fake-Docker lifecycle test proving create/attach/start, bind/abort,
   disconnect kill, deadline-timer creation, terminal evidence, ordered removal,
   and startup orphan sweep without daemon authority in the unit suite.
3. Replace the direct Bun spawn adapter with the Unix-socket adapter while
   preserving the existing SQLite bind CAS and token-fenced lifecycle.
4. Add h2puni-only real-Docker tests for native memory overrun, generic crash,
   deadline overrun, disconnect, supervisor restart, stale bind, and two
   coordinators. Sample managed containers against all unreleased rows and
   solve-start state against `running` rows.
5. Install the lingering restart-always user service and runtime directory via
   existing deploy tooling, mount only that directory into backends, and make
   deployment refuse a missing supervisor, a prod image/commit mismatch, or a
   dev mapping incompatible with the solver contract.

## Assumptions and falsifiers

1. **Assumption:** disposable Docker containers are the smallest existing host
   boundary supplying RSS evidence and an external kill. **Falsifier:** if
   Docker can safely delegate only `be-01`'s own cgroup subtree without sibling
   or host authority, use direct children in that subtree and delete this
   supervisor.
2. **Assumption:** `SO_PEERCRED` plus the peer PID's host cgroup reliably binds
   a connection to its container. **Falsifier:** if the real h2puni probe cannot
   prove that binding, use one host-written per-colour socket mapping; never
   fall back to caller-asserted identity alone.
3. **Assumption:** the stated input/output ceilings cover every accepted plan.
   **Falsifier:** measure a valid request or response above one; raise only that
   bound to the smallest measured ceiling and retain its oversize control.
