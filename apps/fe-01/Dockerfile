# apps/fe-01/Dockerfile
#
# Build from the repo root:
#   docker build -f apps/fe-01/Dockerfile \
#     --build-arg VITE_BE_URL=... --build-arg VITE_GW_URL=... --build-arg VITE_WS_URL=... \
#     -t wbs-fe-01:local .
#
# Decision 5: fe-01 is a normal static-server container, not a data image.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.base.json nx.json ./
COPY libs ./libs
COPY apps/fe-01 ./apps/fe-01
ARG VITE_BE_URL
ARG VITE_GW_URL
ARG VITE_WS_URL
# Vite inlines import.meta.env.VITE_* at build time by reading them out of
# process.env. Docker exports declared ARGs into the RUN step's shell, but
# that's an implicit, easy-to-break contract (it depends on the RUN command
# actually inheriting the shell env, and silently produces an *empty*
# baked-in value if it doesn't) — so promote them to ENV explicitly here,
# which is unambiguous and survives regardless of how the build command below
# is invoked.
ENV VITE_BE_URL=$VITE_BE_URL
ENV VITE_GW_URL=$VITE_GW_URL
ENV VITE_WS_URL=$VITE_WS_URL
# Bun's JIT segfaults partway through this build under QEMU amd64 emulation
# (e.g. building for linux/amd64 on an arm64 host) once JIT-compiled code
# paths get hot enough — a small `bun -e` works, the real vite/rollup build
# does not. Disabling the JIT costs some build-time speed but is otherwise
# behavior-neutral (it only affects Bun's own execution, not the emitted
# assets) and keeps the build reproducible across native and emulated hosts.
ENV BUN_JSC_useJIT=0
RUN bunx nx run fe-01:build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/dist/apps/fe-01 /srv/www
COPY apps/fe-01/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
