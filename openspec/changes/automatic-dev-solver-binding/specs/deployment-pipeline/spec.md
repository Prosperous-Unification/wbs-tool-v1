## MODIFIED Requirements

### Requirement: A solver-affecting commit prepares its dev binding automatically

The dev Deploy trigger SHALL prepare and verify a host-owned Solver
compatibility binding before resetting the live checkout when the target changes
solver compatibility inputs. It MUST build from the target revision, use the
registry-returned immutable digest, and keep registry, Docker, systemd, and
image-selection authority out of application containers and CI.

#### Scenario: a real solver source change deploys without a human

- **WHEN** `origin/main` changes a file under `libs/solver-py`
- **THEN** one trigger run prepares and verifies the target binding, resets dev
  to that target, and the served-commit proof succeeds without an operator step

#### Scenario: an unrelated target reuses the binding

- **WHEN** the installed binding is compatible with the target and no solver
  compatibility input changed
- **THEN** the trigger performs no image publish or config install and proceeds
  through the existing preflight

#### Scenario: preparation fails before reset

- **WHEN** build, publish, config materialization, install, or post-install
  verification fails
- **THEN** the live checkout remains at its previous commit, the trigger exits
  non-zero with the failing phase, and the existing deploy-health alarm reaches
  its threshold within ten poll ticks

#### Scenario: an interrupted preparation is retried safely

- **WHEN** a trigger stops after publish or during installation and the next
  tick retries the same compatibility identity
- **THEN** it reuses only a verified immutable digest, never installs a binding
  for different source bytes, and completes or fails closed before reset
