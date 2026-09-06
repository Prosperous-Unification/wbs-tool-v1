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
