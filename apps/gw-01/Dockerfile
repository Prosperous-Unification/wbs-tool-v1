# apps/gw-01/Dockerfile
#
# Build from the repo root:
#   docker build -f apps/gw-01/Dockerfile -t wbs-gw-01:local .
#
# See apps/be-01/Dockerfile for why 1.3.14 (not 1.2.x) and --production.
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.base.json ./
COPY libs ./libs
COPY apps/gw-01 ./apps/gw-01
WORKDIR /app/apps/gw-01
EXPOSE 3200
CMD ["bun", "run", "src/main.ts"]
