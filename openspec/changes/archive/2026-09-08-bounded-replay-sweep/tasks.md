## 1. Bound replay selection work

- [x] 1.1 Add production-record iterator-count regressions at 100/1,000/10,000 subscriptions and watch the key-array implementation exceed the bound.
- [x] 1.2 Retain a map iterator, cover wrap/deletion/new subscriptions, and keep expiry/coverage regressions passing.
- [x] 1.3 Restore the key-array fault and remove expiry sweep/coverage eviction; record actual negative failures before Proof comments.
- [x] 1.4 Measure expiry bursts, run replay/broadcaster suites and scoped lint, and record parent-owned typecheck/workspace gate status.
