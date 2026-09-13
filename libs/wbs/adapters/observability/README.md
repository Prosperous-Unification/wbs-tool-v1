# observability

The one logger and the one metrics seam, so three tiers' output can be read as
one stream. `runtime:bun`; OpenTelemetry and pino are process adapters.

## Five files

- **`logger.ts`** — `createLogger({ service })`, the pino logger every app
  builds from.
- **`log-schema.ts`** — the fields a line may carry, so a query across tiers is
  written once.
- **`serializers.ts`** — how an `err`, a request and a response are rendered.
- **`metrics.ts`** — `Counter`, over the OpenTelemetry meter.
- **`prometheus.ts`** — framework-free Prometheus collection for app-owned HTTP
  endpoints.

## Refusals

Nothing here refuses anything: a logger that threw would turn a reporting
problem into a failed request. It is also the one place in the repo where
swallowing is correct, and it is bounded to **writing a line**.

## Landmines

- **Never print a secret value.** The serializers exist so that an `err` with a
  request on it does not carry an `authorization` header into a log line.
- `Counter` had **no caller** until gw-01's socket seam; a metric nothing
  increments is a dashboard that reads zero and means "not wired".

## Test

```sh
bunx nx run observability:test
```
