// `tanstack-adapter.ts` was here until 2026-09-02 and is deleted: a 16-line
// wrapper turning a frame into an `onCollectionUpdate` call, for a TanStack DB
// this repo has never depended on. Nothing imported it, and the collection it
// was written against is not the shape fe-01 reads a plan with — the table
// refetches, on purpose (`project-stream.ts` has the argument).
export * from './reconnecting-ws';
export * from './subscription-tracker';
