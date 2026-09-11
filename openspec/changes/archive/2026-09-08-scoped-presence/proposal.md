## Why

Presence already indexes project membership, but every join, move, unsubscribe and disconnect sends rosters to every connection. With 1,000 connections across 100 projects, an unprojected newcomer causes 1,001 frames even though no existing project changed.

## What Changes

Presence mutations identify the projects whose membership changed. Delivery visits only members of those projects and serializes each affected roster once. A newcomer receives its own initial empty roster; a connection leaving its current project receives its empty replacement roster. Moves notify both old and new projects. Rejoining a connection id removes its old membership and notifies that project's remaining members.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `realtime`: scope presence delivery to changed project memberships while retaining initial/reset rosters and connection identity.

## Impact

Gateway-local follow-up to W2-14, authorized by the refactoring plan §67 R7. Scope: Presence, gateway composition, presence and fan-out tests. Preserve existing frame shapes, project-content isolation, username deduplication across separate tabs, and authentication open/close races. Unknown connections and unchanged membership remain controlled no-ops. No backend/client transport changes, authorization redesign, replicas or shared presence backplane. Implementation runs in the isolated refactoring-r7 worktree; integration gates remain parent-owned.

## Non-Goals

No protocol, authorization, backend transport or replica changes.

## Constraints

Preserve R4 wire decoding and validation, close/verification ordering, and project-content isolation.

## Domain Terms

None newly resolved; the approved plan supplies project, connection and roster.

## Decisions Recorded

None.
