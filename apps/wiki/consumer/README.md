# Running the Tool Wiki in your repository

The Tool Wiki is released as a **toolkit**: the parts that are the same for every repository and
every commit — the launcher, the snapshotter, the validator bundle and the TypeScript runtime
closure — plus a standalone preparer. It certifies nothing on its own.

An activation binds exactly one candidate identity, so no archive published by this repository can
certify a commit of yours. You produce your own activation, from the toolkit and your own commit,
and it is green for that commit and no other. See
`docs/adr/0026-a-wiki-release-is-a-toolkit-not-a-certification.md`.

## 1. Copy the workflow

Copy `trusted-wiki.yml` to `.github/workflows/trusted-wiki.yml` in your repository, unchanged. It
contains no repository literal: everything it needs comes from the three variables below and from
the archive itself. Make `trusted-wiki` a required check in your ruleset — it runs on
`pull_request_target`, so it is base-owned and a pull request cannot edit the workflow that judges
it. The required-check setting is administered outside any repository file; candidate YAML cannot
turn it on.

## 2. Set three repository variables

| Variable                              | Value                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOOL_WIKI_ACTIVATION_VERSION`        | the 40-hex commit your activation certifies. Provisioning refuses an archive whose selected manifest `sourceRevision` differs from it, naming both.                                     |
| `TOOL_WIKI_ACTIVATION_ARCHIVE_URL`    | an HTTPS URL for the activation tar — a release asset of **your** repository.                                                                                                           |
| `TOOL_WIKI_ACTIVATION_ARCHIVE_SHA256` | the SHA-256 the preparer printed for that tar. It is the whole trust root: the launcher and the runtime the check runs come from these bytes, and nothing checks out the wiki's source. |

Set all three together. With some but not all of them set, the job fails rather than skipping — an
unconfigured wiki is visible, never green.

## 3. Author the three policy files

They can live at any committed paths; you pass the policy and mapping paths to the preparer, and
the policy names the relationship declarations.

- **`policy.json`** — boundaries (a `selector` per boundary, its `baselineEntries` as
  `git ls-tree -r <pilot sha> -- <prefix>` tuples, and its `obligationIds`), the obligations with
  their `checkIds` and `reviewIds`, the classification policy, and `pilot.sourceRevision`.
  A policy with a pilot and an empty baseline is refused.
- **`modules.json`** — the module mapping: one entry per module with its id, path prefix and the
  README that carries its `module-index` marker.
- **`relationships.json`** — the relationship facts, including one `nx-target` fact per check id
  whose `expectedConfiguration` is that target's whole configuration.

Your repository must be a git + Bun + Nx workspace with `project.json` targets and pinned `nx` and
`typescript` versions in `package.json`, plus a `.bun-version`. The preparer reads all of them at
the candidate commit and refuses an operator Bun that differs.

### `pilot.sourceRevision` for a first activation

`pilot.sourceRevision` names the commit whose tree your baselines were taken from. It cannot be the
candidate itself: the value has to be written into a file, and that file's commit hash is not known
until after the commit exists. So a first activation names an earlier commit — typically the one
just before the policy landed — and the commit that adds the policy is the candidate.

### The `module-index` marker

One HTML comment per module README, holding the version-1 envelope:

```html
<!-- module-index {"schemaVersion":"1","moduleId":"module.example","memberships":[{"kind":"directory-prefix","prefix":"src/example"}],"relationshipSelectors":[],"applicableChecks":["check.example.test"],"inapplicableSections":[{"section":"relationships","reason":"No declared relationships."},{"section":"invariants","reason":"No cross-file invariant."}],"externalConsumers":{"kind":"none-known","knowledgeLimit":"Repository-local knowledge only."}} -->
```

`relationshipSelectors` and `applicableChecks` must be empty exactly when the matching
`inapplicableSections` entry says so; an undeclared key is rejected.

## 4. Obtain a review record and an audit strata file

Both are **operator attestation**. The preparer validates them and never writes them.

- The **review record** is an `AuditReview` your review harness produced for that exact commit. The
  preparer refuses a record that does not bind the candidate — its `candidateIdentity`, its
  `sourceBase`, the reviewed subject, the generation and both completed phases. Any commit after
  the review invalidates it. The harness is yours; this repository ships none.
- The **audit strata file** is the risk table your repository accepts:

  ```json
  {
    "strata": [
      {
        "stratumId": "risk.public-admission",
        "sampleRateBps": 10000,
        "disagreementTriggerBps": 10000
      }
    ],
    "obligations": { "review.example.module": "risk.public-admission" }
  }
  ```

  A policy review with no stratum here is refused by name rather than given a default.

## 5. Verify the toolkit, then prepare your activation

Verify the release asset before you run anything out of it. The toolkit's own digests are inside
the archive, so they prove nothing about the archive you downloaded:

```sh
sha256sum wiki-vX.Y.Z.tar          # compare with the SHA-256 on the release page
mkdir toolkit && tar -xf wiki-vX.Y.Z.tar -C toolkit
(cd toolkit && sha256sum -c SHA256SUMS)
```

`SHA256SUMS` covers `toolkit.json` and the four role files. It does **not** list the ~24 MB of
vendored TypeScript under `trusted-node-modules/`; `toolkit.json` carries a single
`trustedNodeModulesIdentity` over that whole closure instead, and the preparer checks it — along
with every role digest and the Bun version — before it copies anything.

From a clean checkout at the reviewed commit, with the toolkit extracted and verified:

```sh
bun <toolkit>/prepare-activation.mjs \
  --candidate-repository <clean checkout whose HEAD is the SHA> \
  --candidate-sha <40-hex candidate SHA> \
  --toolkit <extracted toolkit directory> \
  --candidate-policy <repo-relative path to policy.json> \
  --candidate-mapping <repo-relative path to modules.json> \
  --review-record <AuditReview record for that SHA>.json \
  --audit-strata <audit strata>.json \
  --destination <new archive root, outside the checkout> \
  --work <retention directory, outside the checkout> \
  --resource-lane <lane the checks ran in> \
  --cwd-identity <identity of that working directory>
```

Every flag is required. `--resource-lane` and `--cwd-identity` have no default on purpose: they are
the operator attestation the check receipts carry, and a tool that invented them would be attesting
on your behalf.

The command runs your declared checks, derives the per-commit roles, digest-checks every toolkit
role against `toolkit.json`, assembles the archive root, and proves it by running the toolkit's own
launcher to `certified: true` before writing the tar. It then prints the tar path, its SHA-256 and
the three `gh variable set` commands.

## 6. Publish and open a pull request

Publish the tar as a release asset of your repository, set the three variables, then open a pull
request at that commit and watch `trusted-wiki`. It is green for exactly the prepared commit: one
authority certifies one commit, so the next candidate needs its own activation. Landing a move of
a boundary's files has its own procedure — see
[the relocation runbook](https://github.com/Prosperous-Unification/wbs-tool-v1/blob/main/docs/runbook-tool-wiki-activation.md#relocation).
