---
status: accepted
---

# Shared Git admission authority

Concurrent worktrees need one admission authority per common Git directory. Atomically
claim canonical paths and conflict groups with a session and generation; accept immutable
submissions, keep claims through integration, and reject stale generations. Integration
checks the actual combined candidate and read dependencies before a compare-and-swap of
the integration ref. An expired heartbeat permits investigation and fencing, not automatic
reassignment of a live writer's authority.

The authority uses a local SQLite store with transactional admission and explicit corruption,
unreadability and bounded-contention outcomes. It does not share the product database.
Policy and verifier identities come from a trusted binding outside the candidate being
judged; a candidate cannot weaken the checks that admit itself. A local cooperative-host
receipt states that trust scope, while enforced CI evidence requires the trusted harness's
invocation provenance.

Per-worktree lock files and prompt-only ownership were rejected because neither can fence
a resumed stale writer nor validate the combined result. A distributed multi-clone service
is outside this first implementation: it adds coordination authority the current workflow
does not need. The mechanism refuses out-of-scope publication; it does not claim to prevent
every editing-time filesystem write. Protocol, state machine, failure tests and activation
sequence are in [the change](../../openspec/changes/agent-scalable-llm-wiki/design.md).
Accepted under the user's 2026-09-08 authorization to resolve assumptions autonomously;
no authority has been activated by writing this decision.
