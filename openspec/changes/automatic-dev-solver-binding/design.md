# Automatic dev solver binding — design

The Deploy trigger owns a clean, target-revision checkout separate from both
the live dev checkout and human worktrees. One host lock covers compatibility
detection, preparation, preflight, reset, and the served-commit proof. The
target's preparation code runs from that checkout or a bundle made from it; it
must not import from the older live tree.

The preparation identity is the target tree identity of
`SOLVER_COMPATIBILITY_PATHS`, not merely the target commit. Durable host state
records that identity, the full source SHA used in the installed binding, and
the registry-returned digest. A matching identity may reuse its image across an
unrelated successor commit by durably rebinding the full source SHA before host
mutation. Missing, malformed, partial, or identity-mismatched state fails closed.

For a new identity the trigger publishes only the be solver image, records the
registry-returned immutable digest, renders the complete supervisor config with
the current prod colour identities and target source SHA, and invokes the
existing installer. The installer remains the only writer of service/config
state. Only after its preflight proves the exact digest and target compatibility
does the live checkout reset. Config publication, supervisor restart, readiness,
and mapping checks share the production deploy lock with every production swap.

An interruption before a digest is recorded repeats or discovers the immutable
publish. An interruption after publish but before install reuses the digest. An
interruption during install relies on the installer's atomic, verified contract
and retries it. No state is marked complete until the post-install preflight
succeeds. A completed record still rechecks service, socket, config, and mapping;
a failed recheck reinstalls once under the production lock. The existing
ten-failure alarm owns notification; preparation does not invent a second owner
channel.
