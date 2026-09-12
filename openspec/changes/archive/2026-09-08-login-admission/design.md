## Admission ownership

`mountedRouteLists` composes one `LoginThrottle` for auth routes with an explicit `AppOptions.maxConcurrentLogins` cap (eight by default). The cap is per process, not shared across blue and green. The constructor refuses non-positive, non-integral and non-finite settings. No waiter queue is retained.

`LoginThrottle.reserve` synchronously checks the global count and each normalized account/IP failure window. It records pending counts on those windows before the auth route awaits `AuthService.login`. The returned release closes over those admitted windows, belongs to that attempt, and runs once in the route's `finally`.

## Failure-window lifetime

A pending reservation cannot disappear when another attempt succeeds or a failure window expires. Success clears the account's settled failures while retaining its pending count. Expiry clears expired failures but retains pending work; global map eviction also excludes active windows. The first settled failure starts the existing sixty-second failure window, so a slow verification does not shorten it by starting the clock at admission. IP failures remain after a successful login, matching the existing behavior.

Registration retains its existing charge-before-hash policy. It shares the failure windows, but the new global admission cap is for password login only. Unexpected password-verifier errors propagate, like the account errors corrected by R3; the route releases admission even when no credential refusal can be recorded.
