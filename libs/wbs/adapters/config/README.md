# config

One process's environment, checked at boot against the schema it declares.
`runtime:bun` — it reads files and spawns `sops`.

## Four files

- **`define-config.ts`** — `defineConfig(schema, env)`: the whole environment in,
  a typed config out, or a throw naming the variable.
- **`env-schemas.ts`** — the shared arktype pieces the three apps' schemas are
  built from.
- **`sops-loader.ts`** — `loadSopsDecrypted(path)`, for the encrypted `.env`
  files the deploy hands a container.

## Refusals

A missing or malformed variable **throws at boot** and the process does not
start. That is the one place R5's "unknown is not OK" is unarguable: a server
that started with `AUTH_MODE` unset would answer requests with a guess.

## Landmines

- **A refusal must never print a value.** `defineConfig` goes through
  `parseSecretsOrThrow` for that reason and no other — the env it is handed holds
  every signing key and shared secret this deployment has. It went through
  `parseOrThrow` until 2026-09-02, and one mistyped `LOG_LEVEL` printed the lot
  into the boot log.
- **`sops` failing is a throw, not an empty map.** An unreadable secrets file
  read as "no secrets" is a process that boots with defaults where credentials
  were owed.

## Test

```sh
bunx nx run config:test
```
