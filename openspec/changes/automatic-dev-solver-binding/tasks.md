# Tasks — Automatic dev solver binding

- [x] 1. Isolate compatibility detection and define a target-tree identity;
      watched red: changing one solver byte must change it while an unrelated
      source change must not.
- [x] 2. Add a target-pinned preparation runner and durable state decoder;
      watched reds: old-live-tree imports, missing state, partial state, and a
      digest/compatibility-identity mismatch all refuse before host mutation.
- [x] 3. Compose publish, materialization, installer, and post-install preflight
      behind injected boundaries; watched reds remove each phase and prove no
      reset can occur.
- [x] 4. Put preparation through reset under one exclusion boundary; prove two
      overlapping triggers cannot publish/install different target bindings.
- [x] 5. Prove retries after publish and interrupted install reuse only the
      matching immutable digest and never mark incomplete state complete.
- [x] 6. Update the dev deploy runbook and target-candidate installation path.
- [x] 7. Run focused and full gates on h2puni, then exercise a real
      `libs/solver-py` change through a live poll tick and record image digest,
      binding source SHA, checkout SHA, served SHA, and alarm state in `verify.md`.
- [ ] 8. Complete exact-head prod review and green CI; hand off without merge.
