---
status: accepted
---

# The dev deploy trigger owns solver compatibility preparation

When a target revision changes `libs/solver-py` or `apps/be-01/Dockerfile`, the
dev deploy trigger on h2puni must prepare the target's Solver compatibility
binding before the deploy preflight and checkout reset. Preparation is
host-owned, target-revision-pinned, idempotent, and serialized with the deploy:
it builds and publishes the immutable solver image from a clean target checkout,
materializes the source-to-digest binding, installs it through the existing
supervisor installer, and then lets the existing preflight verify the result.
An unrelated revision reuses the installed binding when the compatibility diff
is empty. The live dev container never receives registry, Docker, systemd, or
image-selection authority.

## Considered options

- **Publish and install from CI:** rejected because it gives GitHub Actions
  registry and h2puni mutation authority that the current main-only deploy
  trigger already has locally. It also splits one transition across two
  independently retried systems.
- **Fail, alarm, and file an owner task:** retained as the recovery path, not
  the normal path. The ten-tick alarm makes a refusal visible but still turns
  every future solver change into a human build/install prerequisite; the
  current incident reached 420 consecutive failures and parked the dev queue.
- **Remove the binding or let the backend select its image:** rejected because
  it breaks the host-authority boundary and can pair changed solver sources with
  an older or caller-selected image.

## Consequences

The first deploy for a new compatibility identity is slower and can fail during
build, publish, or installation. Such a failure remains before reset, is safe to
retry from its durable identity, and is still surfaced by the existing
ten-tick deploy-health alarm. A successful install atomically replaces the
host-wide supervisor config and restarts the supervisor used by both dev and
production callers. That brief prod solver interruption is accepted, but the
config move, restart, readiness proof, and mapping proof run under the canonical
production deploy lock, so they cannot interleave with a production swap.
Implementation must begin with an OpenSpec change, keep preparation and reset
under one dev exclusion boundary, prove interrupted retries do not publish or
install a mismatched binding, and exercise a real solver-path change on h2puni
before TASK-326 closes.
