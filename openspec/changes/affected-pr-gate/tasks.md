Ordered TDD slices. Every slice's oracle reads the production `.github/workflows/ci.yml`
through `Bun.YAML.parse` or as text; there is no copy of the workflow to assert against.

## 1. Gate scope per event

- [x] 1.1 Extend `tools/tool-devsync/src/toolchain-pins.test.ts` with the gate-scope oracle:
      the `Gate mode` step maps `pull_request` to `nx affected` with the payload base SHA and
      `push`/`merge_group`/`workflow_dispatch` to `nx run-many`, and the mapped set equals the
      workflow's `on:` subscriptions — test: `bunx nx test tool-devsync --skip-nx-cache`, red
      before the workflow changes.
- [x] 1.2 Add the `Gate mode` step and the affected branch of the Nx gate step to the
      workflow, keeping its three-part shape and `--exclude=tool-wiki` — test:
      the same suite green; `gate-entrypoints.test.ts` stays green on both tool-wiki literals.
- [x] 1.3 Safety check: the `*)` arm refuses an event with no gate rule — test: the mapped set
      equals the subscribed set and the refusal arm is present; negative: delete the `*)` arm
      from the production workflow, observe the pin suite fail, restore, record the observed
      expectation in `verify.md`.
- [x] 1.4 Safety check: Tool Wiki's targets run on a pull request when `tool-wiki` is affected,
      read from `nx show projects --affected --json` via `jq` — test: the pin suite asserts the
      `jq` membership read and both tool-wiki commands inside the affected branch; negative:
      remove the tool-wiki branch, observe the pin suite fail; and separately confirm the
      `grep`-on-`--sep` form the brief proposed can never match, since `nx show projects`
      emits JSON on a non-TTY.

## 2. Browser shards follow the switch

- [x] 2.1 Extend `tools/tool-git-hooks/src/hooks/pixels-workflow.test.ts` with the shard-scope
      oracle: a `pixels_mode` job computes the boot-set membership, `pixels_shard` is gated on
      its output, and `pixels` needs both jobs — test: `bunx nx test tool-git-hooks` with
      `--skip-nx-cache`, red before the workflow changes.
- [x] 2.2 Add `pixels_mode`, gate `pixels_shard` on it and rewrite the `pixels` aggregate so a
      skip is only accepted when the scope job said the stack is unaffected — test: the same
      suite green, existing shard/matrix/artifact assertions untouched.
- [x] 2.3 Safety check: `pixels` refuses a skip it cannot explain — test: the aggregate script
      requires `needs.pixels_mode.result` to be `success` and matches its reported verdict;
      negative: reduce the script to `test "${{ needs.pixels_shard.result }}" = success`,
      observe the pin suite fail, restore.

## 3. Reachability of the oracles under the affected gate

- [x] 3.1 Declare `{workspaceRoot}/.github/workflows/ci.yml` in the `test` inputs of every
      project whose suites read it (`tool-git-hooks`, `tool-wiki`) — without it a pull request
      editing only `ci.yml` never schedules the suite that is entirely about `ci.yml`. Test:
      `bunx nx show projects --affected --files=.github/workflows/ci.yml --json` lists
      `tool-git-hooks`.
- [x] 3.2 Safety check: `workspace-targets.test.ts` requires that declaration of every project
      whose test sources name a tracked workflow, in either spelling, over a parametrised
      list rather than one hard-coded path — test: the oracle, with a self-proving
      non-vacuity assertion; negative: run it against the manifests before the inputs are
      added and observe both project names listed, then with `trusted-wiki.yml` undeclared
      and observe `tool-wiki:test` listed again.
- [x] 3.3 Safety check: both scope switches distinguish jq's `false` from jq failing — test:
      both pin suites require the `type == "array"` assertion, the explicit status capture and
      the `*)` exit arm; negative: return either switch to its two-branch form and observe the
      pin fail, and watch the two-branch form print `skip`/`unaffected` and exit 0 on a
      non-array in a real shell.

- [x] 3.4 Safety check: the refusal-arm pins are breakable — the arm extractor matches only
      outer `case` arms, the arms hold exactly one `*`, the refusal is pinned as its message
      and `exit` together, and both suites strip comment lines first so a pin cannot be
      satisfied by the `Proof:` note about it — test: both pin suites; negative: in each
      scope step delete the whole `*)` arm and observe the star assertion fail, then delete
      only its `exit 1` and observe the normalised-pair assertion fail; and reflow the
      in-script Proof comment onto one line with that `exit 1` gone and observe the pre-fix
      pin pass on its own comment.

- [x] 3.5 Safety check: the selector between the two gate arms is pinned — the predicate
      `if [ "$GATE_MODE" = affected ]; then`, each event arm paired with the mode it writes,
      and each gate BRANCH paired with the command its body runs, all as normalised strings
      — test: `toolchain-pins.test.ts`; negative: flip the predicate to `if true` and observe
      it fail; exchange the two event arm bodies and observe the pairing fail; exchange the
      gate step's `then` and `else` bodies and observe the branch pairing fail — that last
      one passed 17/0 until the branch pairing was pinned, because a swap moves commands
      without adding or removing any.
- [x] 3.6 Safety check: both membership reads slurp, so a document printed ahead of the
      project array cannot be skipped — test: both pin suites require `jq -s` with
      `length == 1`; negative: drive the extracted production step script with a `bunx`
      stub printing two documents and watch the unslurped form answer `tool_wiki=skip`,
      exit 0, with `tool-wiki` present in its own output.
- [x] 3.7 Safety check: the `pixels` aggregate refuses rather than continues — test:
      `pixels-workflow.test.ts` requires the script to open with `set -euo pipefail`, which
      is what makes its first `test` a refusal; negative: remove that line and observe the
      pin fail.

- [x] 3.8 The `check.tool-wiki.test` fact in `docs/wiki-policy/relationships.json` and
      `relationships.bootstrap.json` declares the target's real `inputs` — a fact pins a
      target's whole configuration and the declarations extractor refuses drift. Test:
      `bunx nx test tool-wiki --skip-nx-cache`; negative: with the fact left at
      `["default", "^production"]` the production CLI reported
      `fact check.tool-wiki.test authority-selector mismatch` and the pilot-policy case
      failed `Expected: 0 · Received: 1`.

## 4. Evidence

- [ ] 4.1 `verify.md` records every command with its result line, both failure proofs with the
      observed expectations, and the live-run rows. OBSERVED: the h2puni exact-head gate on
      `f379e3dd` (exit 0, 31 projects); PR #460's `mode=affected` run over a strict subset
      (30 projects / 105 tasks, gate green, pixels green); and the throwaway negative PR #461,
      red in `shared-validation:typecheck` on the injected `TS2322`. OPEN: the `push` to `main`
      row, which needs the merge; the first `merge_group` row, which needs Dany's ruleset; and
      a docs-only PR showing skipped shards, which is blocked by nothing and simply has not
      been opened.
