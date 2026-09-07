# The only image build in the cheap-dev design. It carries toolchain and no
# application code: the app arrives through a bind mount, so this is rebuilt
# when Bun or Node moves, not when the app changes.
FROM oven/bun:1.4.2-debian

# be-01 and gw-01 run under `bun --watch`, but fe-01 runs `bunx vite`, and
# vite's bin starts with `#!/usr/bin/env node` -- bunx honours the shebang and
# hands execution to Node. Without Node here, be and gw come up healthy and
# only fe dies, which makes the cause hard to see from the outside.
#
# procps is not incidental: Nx shells out to `ps` while supervising the three
# serve targets, and its absence killed the whole `bun run dev` process tree
# with `spawn ps ENOENT` -- after be-01 had already announced itself, so the
# environment looked partly healthy.
ENV NODE_VERSION=24.18.1
# The tarball keeps its published filename: SHASUMS256.txt lists files by that
# name, and `sha256sum -c` resolves it relative to the working directory. Saving
# it as anything else makes the verification silently unresolvable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl xz-utils git ca-certificates procps \
  && cd /tmp \
  && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  && grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c - \
  && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
  && rm -rf "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" /tmp/SHASUMS256.txt /var/lib/apt/lists/* \
  && node --version \
  && bun --version

WORKDIR /src
CMD ["bun", "run", "dev"]
