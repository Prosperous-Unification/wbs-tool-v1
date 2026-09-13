# Memory source adapter

<!-- wbs-index {"schemaVersion":1,"moduleId":"module.adapter.store-memory","memberships":[{"kind":"path","path":"actual-fixture.ts"},{"kind":"path","path":"auth-fixture.ts"},{"kind":"path","path":"calendar-marker-fixture.ts"},{"kind":"path","path":"capacity-fixture.ts"},{"kind":"path","path":"command-journal-fixture.ts"},{"kind":"path","path":"dependency-fixture.ts"},{"kind":"path","path":"directory-fixture.ts"},{"kind":"path","path":"estimate-fixture.ts"},{"kind":"path","path":"history-fixture.ts"},{"kind":"path","path":"in-memory-source.ts"},{"kind":"path","path":"index.ts"},{"kind":"path","path":"measure-fixture.ts"},{"kind":"path","path":"memory-source.test.ts"},{"kind":"path","path":"memory-work-item-fixture.ts"},{"kind":"path","path":"priority-band-fixture.ts"},{"kind":"path","path":"progress-fixture.ts"},{"kind":"path","path":"project-fixture.ts"},{"kind":"path","path":"replay-fixture.ts"},{"kind":"path","path":"source-conformance.test.ts"},{"kind":"path","path":"source.ts"},{"kind":"path","path":"step-fixture.ts"},{"kind":"path","path":"subtree-fixture.ts"},{"kind":"path","path":"testing/service-fixtures.ts"}],"relationshipSelectors":["declarations.facts","nx.dependencies","typescript.imports","typescript.public-declarations","typescript.reverse-edges"],"applicableChecks":["check.store-memory.test"],"inapplicableSections":[{"section":"invariants","reason":"Port conformance belongs to source-conformance.test.ts and the implemented port symbols."}],"externalConsumers":{"kind":"declared","memberships":[{"kind":"directory-prefix","prefix":"libs/core","exclusions":[]},{"kind":"directory-prefix","prefix":"libs/store-sqlite/src","exclusions":[]},{"kind":"directory-prefix","prefix":"apps/be-01/src/testing","exclusions":[]}],"knowledgeLimit":"Only selected in-repository test and composition consumers are declared."}} -->

This adapter implements core storage ports without SQLite and owns reusable test fixtures. The
[public barrel](index.ts) exposes production-shaped memory sources; test-only composition stays
under [testing](testing/service-fixtures.ts).

## Checks

The applicable check is the `store-memory:test` target declared in
[the adapter project](../project.json).
