# Verification Report

> Produced by `openspec-verify-change` AFTER apply completes. Failed checks go
> back to the artifact that caused them; then re-run verify.

**Change**: `<change-name>`
**Verified at**: `YYYY-MM-DD HH:mm`
**Verifier**: `<who / which agent>`

---

## 1. Structural Validation

- [ ] `openspec validate --all --json` — all items `"valid": true`

```
<paste the summary>
```

| Item | Type | Issues |
| ---- | ---- | ------ |
| —    | —    | —      |

---

## 2. Task Completion

- [ ] Every `- [ ]` in tasks.md is now `- [x]`

| Task | Reason incomplete | Blocks archive? |
| ---- | ----------------- | --------------- |
| —    | —                 | —               |

---

## 3. Delta Spec Sync

| Capability | Sync status                | Note |
| ---------- | -------------------------- | ---- |
| —          | ✓ synced / ✗ pending / N/A | —    |

---

## 4. Failure Proofs

> REQUIRED. Every new or changed safety check gets a row. A check with no proof
> is not done. Checks that cannot fail have shipped in this repo six times —
> `assertPragmas` with no runtime caller, the migration lint's unreachable
> RENAME COLUMN branch, `readRemoteState` reading an unreadable file as
> never-deployed, `shellcheck … || echo`. This table is why it stops.
>
> "Reasoned about it" is not a proof. You must have watched it fail.

| Check (file:line) | Fault injected | Test that observed the failure | Result |
| ----------------- | -------------- | ------------------------------ | ------ |
| —                 | —              | —                              | —      |

- [ ] Every check in this change has a row
- [ ] Each negative test reaches the production call path, not a copy of it
- [ ] Where code distinguishes filesystem state, both absence AND unreadability
      were tested
- [ ] No row relies on an exit code unless the tool's contract guarantees the
      effect (`caddy reload` exits 0 having done nothing)

---

## 5. Gate Output

> There is no CI. This is the only gate.

- [ ] `bunx nx run-many -t test lint typecheck`
- [ ] `bunx nx format:check`

```
<paste the actual output — not a summary of it>
```

---

## 6. Implementation Signal

- [ ] No unstaged files in the worktree
- [ ] Relevant commits pushed

**Commit range**: `<from-sha>..<to-sha>`

---

## Decision

- [ ] ✅ PASS — proceed to finishing-a-development-branch and archive
- [ ] ⚠️ PASS WITH WARNINGS — `<what, and why it does not block>`
- [ ] ❌ FAIL — `<which artifact to return to>`

**Next step**:

<what happens now>
