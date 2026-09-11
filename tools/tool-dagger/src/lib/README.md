# Release assembly library

<!-- wbs-index {"schemaVersion":1,"moduleId":"module.infra.release-assembly","memberships":[{"kind":"path","path":"bundle.ts"},{"kind":"path","path":"image.ts"},{"kind":"path","path":"publish.test.ts"},{"kind":"path","path":"publish.ts"}],"relationshipSelectors":["declarations.facts","typescript.imports","typescript.reverse-edges"],"applicableChecks":["check.tool-dagger.test"],"inapplicableSections":[{"section":"invariants","reason":"Bundle and publication invariants remain on their symbols and publish tests."}],"externalConsumers":{"kind":"declared","memberships":[{"kind":"path","path":"tools/tool-dagger/src/be-01.ts"},{"kind":"path","path":"tools/tool-dagger/src/dagger.test.ts"},{"kind":"path","path":"tools/tool-dagger/src/fe-01.ts"},{"kind":"path","path":"tools/tool-dagger/src/gw-01.ts"},{"kind":"path","path":"tools/tool-dagger/src/main.ts"}],"knowledgeLimit":"Only selected tool-dagger entrypoints are declared."}} -->

Bundle naming, image declarations, and publication operations used by the release entrypoints live
here. Runtime deployment policy remains with the caller and its runbook.

## Checks

The applicable check is the `tool-dagger:test` target declared in
[the tool project](../../project.json).
