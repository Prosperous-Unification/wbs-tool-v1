# validation

One arktype wrapper, so external data is checked once at its boundary and
internal types stay precise after it (AGENTS.md R5). `runtime:isomorphic`.

## Three files

- **`core.ts`** — `parseOrThrow(schema, input)` and
  `parseSecretsOrThrow(schema, input)`, plus the re-exported `type`.
- **`errors.ts`** — `ValidationError`, the one thing a caller catches.
- **`src/fixtures/`** — `makeTestDb`, `injectedClock`, `makeFrame`: the doubles
  every suite in the repo builds a boundary out of.

## Refusals

Both parsers **throw**: a malformed value at a boundary is an unknown, and R5
says an unknown is never converted to a default. What the message may say is the
difference between them, and it is the whole reason there are two.

## Landmines

- **`parseOrThrow`'s message is safe for a caller's own data and unsafe for
  secrets.** Measured on arktype 2.x: a type mismatch reads `PORT must be a
number (was a string)`, but a literal union or a regex **quotes what it got**
  — `MODE must be "dev" or "prod" (was "sekrit")`.
- **So `defineConfig` uses `parseSecretsOrThrow`**, which names the path and
  never the value. It went through the other one until 2026-09-02, and one
  mistyped `LOG_LEVEL` printed every secret be-01 holds into the boot log.
- It used to open every message with `JSON.stringify(input)`, echoing the whole
  value back — for an HTTP body that is the caller's own data arriving twice.

## Test

```sh
bunx nx run validation:test
```
