## Why

ReplayBuffer evicts only one unrelated subscription per record, but builds and searches an array of every key to choose it. Work therefore grows with all subscriptions despite the bounded-eviction claim. This implements refactoring plan §67 R8 before runtime/source extraction.

## What Changes

Subscription selection retains an iterator between records and advances it at most three times per record, including wrap and skipping the just-written subscription. Abandoned subscriptions still expire under ongoing traffic and replay coverage remains unchanged.

## Non-Goals

No byte budget, deque replacement, transport change, or store/package extraction.

## Constraints

Preserve per-subscription age/count limits, deletion rotation and replay fallback. Prove subscription-selection work through production record calls at 100, 1,000 and 10,000 subscriptions. Measure expiry bursts before deciding whether payload eviction needs another change. Existing §67 intent is settled.

## Capabilities

### New Capabilities

- `bounded-replay-sweep`: Subscription-selection work independent of the number of subscriptions.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

be-01 ReplayBuffer and replay/broadcaster regressions.
