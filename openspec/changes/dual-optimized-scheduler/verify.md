# Dual optimized scheduler verification

## 2026-09-06T10:23:22Z — coordinator checkpoint

- Head: `910bfad057ebc4e59dfde279f4ed44810e34dc22`
- Host: `h2puni`, clean checkout `/home/puni1/t220-r25-final2.TsxGEY`
- Command: `NX_DAEMON=false PATH=/home/puni1/t220-venv/bin:$PATH VIRTUAL_ENV=/home/puni1/t220-venv bin/h2puni-gate.sh`
- Verdict: exit 0; Nx successfully ran `test`, `lint`, `typecheck`, and `build` for 24 projects.
- Decisive counts: be-01 1,582 passed / 0 failed; fe-01 2,213 passed / 0 failed; solver-py 191 passed / 0 failed. The remaining project test targets and every build, lint, typecheck, and format target were green.
- Checkout after the gate: clean and still at the exact head above.

Two earlier invocations are deliberately not terminal evidence. The first put
the locked Python virtual environment inside the checkout, so format checking
listed its dependency metadata and exited 1; the environment was preserved
outside the checkout. The second let the Nx daemon fail project-graph
calculation and return 0 without target evidence. Disabling the daemon produced
the complete authoritative run recorded above.

## 2026-09-06T10:36:06Z — transaction-owned event seam

- Head: `607cda22023e41d643c773dc09891785059e42cc`
- Host: `h2puni`, clean checkout `/home/puni1/t220-r25-final2.TsxGEY`
- Command: `bunx prettier --check` over the five changed files, then
  `NX_DAEMON=false bunx nx run-many -t test lint typecheck --projects=be-01 --parallel=1 --skip-nx-cache`
- Verdict: exit 0; be-01 1,668 passed / 0 failed, lint and typecheck green,
  and every changed file formatted.
- Watched negative 1: replacing `recordEventIn`'s supplied transaction writes
  with repository-database writes made the foreign-handle assertion fail
  (7 passed / 1 failed). Restoring the source returned the checkout to clean.
- Watched negative 2: making `pushRecorded` record again made the focused
  broadcaster suite fail (0 passed / 5 failed), including the expected
  sequence 0 becoming sequence 1. Restoring the source returned the checkout
  to clean.

The seam is now explicit: transaction owners call `recordEventIn`, commit, and
then make the best-effort socket push through `pushRecorded`; the convenience
`publish` path composes one durable record with one push.
