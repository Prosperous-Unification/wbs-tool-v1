# apps/be-01/Dockerfile
#
# Build from the repo root:
#   docker build -f apps/be-01/Dockerfile -t wbs-be-01:local .
#
# Uses 1.3.14 (not the 1.2.x line) to match the Bun version this repo is
# developed and tested against locally (bun-types is pinned to ^1.3.13) and
# to avoid `bun.lock` text-lockfile format drift across Bun's 1.2 -> 1.3
# lockfile schema changes.
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --production: be-01 runs its TypeScript source directly under Bun (no
# separate build step), and every runtime import it and its @wbs/* libs pull
# in (elysia, drizzle-orm, pino, @opentelemetry/*, arktype, jose, ...) is a
# "dependencies" entry, not a devDependency. Skipping devDependencies (nx,
# vite, eslint, typescript, ...) keeps ~600MB of build-only tooling out of
# the runtime image.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json ./
COPY libs ./libs
COPY apps/be-01 ./apps/be-01
# runMigrations() resolves './drizzle' relative to cwd, and Bun resolves the
# @wbs/* path mappings from the nearest tsconfig.json walking up from cwd —
# both require cwd to be the app root, not the repo root.
WORKDIR /app/apps/be-01
EXPOSE 3100
CMD ["bun", "run", "src/main.ts"]
