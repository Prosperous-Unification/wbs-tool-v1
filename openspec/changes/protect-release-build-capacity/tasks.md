## 1. Intent and admission

- [x] 1.1 Record the approved release-capacity intent, thresholds, engine
      ceilings, and non-goals in OpenSpec.
- [x] 1.2 Refuse below 8 GiB available memory, above 25% combined tmpfs use, or
      above one runnable task per CPU — test: boundary table; negative: each
      injected unsafe measurement reaches the production admission function.
- [x] 1.3 Refuse a second heavy operation without waiting — test: a real child
      process holds the temporary `flock` and the production lock entrypoint
      reports the holder conflict.

## 2. Bounded engine lifecycle

- [x] 2.1 Create or validate the named engine with 8 GiB memory/no extra swap,
      6 CPUs, and 2,048 PIDs — test: exact Docker create/inspect contract;
      negative: one mismatched ceiling is refused before connection.
- [x] 2.2 Stop the engine after success and after a thrown publish error — test:
      both branches observe the production lifecycle's stop call; negative:
      injected stop failure makes the run fail.

## 3. Shared host gate and operations

- [x] 3.1 Add the h2puni full-gate entrypoint using the same lock and update both
      runbooks — test: lock path equality and ShellCheck.
- [x] 3.2 Run watched REDs, focused green, full gate, format, and OpenSpec on
      h2puni; record every failure proof in `verify.md`.
- [x] 3.3 Publish all three images while recording host telemetry, public vhost
      health, SSH, and monitoring throughout; verify the engine is stopped.
