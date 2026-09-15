# validation

One arktype wrapper, so external data is checked once at its boundary and
internal types stay precise after it (AGENTS.md R5). `runtime:isomorphic`.

## Two things

- **`src/index.ts`** — a bare re-export of `@shared/validation`. The parsers,
  `ValidationError` and the re-exported `type` live in
  `libs/shared/domain/validation`, so a product-less tool can reach them
  without importing a WBS library; their refusals and their landmines are
  documented there and on the symbols themselves.
- **`src/fixtures/`** — `makeTestDb`, `injectedClock`, `makeFrame`: the doubles
  every suite in the repo builds a boundary out of. They stay here because they
  reach for `bun:sqlite` and drizzle. Import them from
  `@wbs/validation/fixtures`.

## Test

```sh
bunx nx run wbs-validation:test
```
