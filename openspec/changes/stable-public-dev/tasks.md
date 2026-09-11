## 1. Public dev has a stable document

- [x] 1.1 Drive the public-mode config test red before implementation: public dev disables HMR,
      while ordinary local serve leaves Vite's HMR default intact.
- [x] 1.2 Set an explicit public-dev process flag in the source-run compose service and consume it
      in the Vite config. Add a `Proof:` comment naming the red test and the missing guard.
- [x] 1.3 Run the focused config test and OpenSpec validation on h2puni; inject the missing HMR
      guard again and record the failing assertion.

## 2. Live evidence

- [ ] 2.1 After TASK-514 unblocks deployment, prove h2puni serves a fresh `origin/main` commit.
- [ ] 2.2 Hold Browser Use Cloud on one page for two minutes in one uninterrupted evaluation;
      record every non-empty body-length sample and fail on any navigation.
- [ ] 2.3 Push an intentional source-only marker change through the normal dev poller and prove a
      fresh browser request receives it, then revert the marker through the same path.
