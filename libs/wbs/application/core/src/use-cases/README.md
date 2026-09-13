# Core use cases

<!-- wbs-index {"schemaVersion":1,"moduleId":"module.application.use-cases","memberships":[{"kind":"path","path":"admission.test.ts"},{"kind":"path","path":"replay.ts"},{"kind":"path","path":"retention-sweep.ts"},{"kind":"path","path":"run-command-batch.ts"},{"kind":"path","path":"save-plan.ts"}],"relationshipSelectors":["declarations.facts","typescript.imports","typescript.public-declarations","typescript.reverse-edges"],"applicableChecks":["check.core.test"],"inapplicableSections":[{"section":"invariants","reason":"Transaction and replay invariants live on the use-case symbols and their conformance tests."}],"externalConsumers":{"kind":"declared","memberships":[{"kind":"path","path":"libs/core/src/index.ts"},{"kind":"directory-prefix","prefix":"libs/core/src/http","exclusions":[]},{"kind":"directory-prefix","prefix":"libs/core/src/service","exclusions":[]},{"kind":"directory-prefix","prefix":"libs/core/testing","exclusions":[]}],"knowledgeLimit":"Only direct and barrel consumers in the selected repository are declared."}} -->

These functions coordinate framework-free application work across core ports. Transport and
storage details remain outside this boundary; the [core barrel](../index.ts) publishes the stable
surface.

## Checks

The applicable check is the `core:test` target declared in
[the core project](../../project.json).
