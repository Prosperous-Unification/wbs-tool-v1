## Context

Presence maintains byConnection and byProject indexes, but broadcast currently iterates every connection. The app calls it after join, enterProject, leaveProject and close. Existing content tests cannot detect redundant traffic; the move test also needs an observer remaining in the old project.

## Mutation and delivery contract

Each membership mutation returns a deduplicated collection of affected project ids. Join returns the prior project's id when replacing a connected id; enterProject returns old and new ids when different; leaveProject returns its id only when it matches the current project; leave returns the prior id before removing the connection. Unknown ids and repeated memberships return no affected projects.

A scoped delivery operation reads members directly from byProject, builds one sorted deduplicated username roster per affected project, and sends only to those connection ids. It does not traverse all connections to select recipients. Mutation updates remove empty project sets, keeping both indexes coherent. Disconnect reads the prior membership through byConnection rather than searching project sets.

Initial and reset delivery are explicit. After join, the new connection receives its own empty roster; it does not belong to a global project. After a matching unsubscribe, the still-connected socket receives an empty roster even though it is no longer an affected project's member. A repeated/stale unsubscribe produces no reset, so it cannot overwrite the destination roster after a move. A replacement connection id gets its new username and socket; the obsolete socket receives no reset. A disconnect sends no frame to the departed socket. Gateway wiring preserves its awaited join and authenticated-identity checks around every mutation.

## Evidence design

Test affected-project returns and index coherence across join, rejoin, move, repeated subscribe, stale/current unsubscribe, unknown ids, disconnect and duplicate usernames. Keep the existing randomized index comparison.

Create 1,000 connections across 100 projects using production Presence mutation/delivery operations with recording sockets. Clear setup frames, join an unprojected newcomer, deliver the returned affected projects and initial roster, then read counts synchronously: 1 new frame and 0 frames to existing connections. Do not derive expected counts from the implementation's returned collection. Restore global delivery and watch the same case receive 1,001 frames. Add targeted transition count checks with literal expected recipients.

Real socket tests establish that buildApp uses these operations: instrument production server writes or use positive same-connection ping barriers before taking one count sample. Keep silence assertions non-retrying. Add an observer remaining in the old project during a move, an unrelated project, and unsubscribe/disconnect cases. Existing verification-race and project-content isolation suites remain required. Inject global delivery on the app-called production operation, not merely a test-local substitute.

## Constraints

No new general-purpose framework or public app option just to support a test. Isolate a send failure as existing controlled socket closure behavior; retain socket-writer outcomes. Replication remains a separate capacity change. No changes to R4's single wire decode or R9's transport seam.
