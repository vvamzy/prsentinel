# ---------------------------------------------------------------------------
# prsentinel runs as a Docker container action: GitHub builds this image at the
# start of every job, runs the entrypoint, and throws the container away.
#
# The runtime image is Ubuntu 24.04 rather than Alpine on purpose. The bundled
# llama.cpp server — used by `llm-model: local/…` — ships as a glibc binary
# built against ubuntu-latest. musl cannot run it at all, and an older glibc
# fails with `GLIBC_x.y not found`.
# ---------------------------------------------------------------------------

# Build stage: compile the TypeScript bundle.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install with a lockfile when present for reproducible builds.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage.
FROM ubuntu:24.04

# Pinned llama.cpp release. Bump deliberately: the OpenAI-compatible server API
# is stable, but the flag set is not.
ARG LLAMA_BUILD=b11731

ENV NODE_ENV=production

# libgomp1 is not part of the ubuntu base image but llama.cpp links against the
# GNU OpenMP runtime; without it llama-server dies at load with
# "libgomp.so.1: cannot open shared object file".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libgomp1 tini curl \
    && rm -rf /var/lib/apt/lists/*

# Node 22, borrowed from the official image rather than a hand-rolled repo setup.
COPY --from=build /usr/local/bin/node /usr/local/bin/node

# llama-server powers `local/…` models (see src/llm/local.ts).
#
# The archive expands to a single directory holding llama-server *and* every
# shared object it needs, including one libggml-cpu-<microarch>.so per CPU
# family. That layout is load-bearing: ggml picks a backend at runtime by
# scanning the directory of its own executable, so llama-server is left in place
# next to its libraries rather than copied onto PATH alone. ~50 MB, which buys
# the only mode that needs no API key.
RUN set -eux; \
    curl -fsSL -o /tmp/llama.tar.gz \
      "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"; \
    mkdir -p /opt/llama; \
    tar -xzf /tmp/llama.tar.gz -C /opt/llama --strip-components=1; \
    rm -f /tmp/llama.tar.gz; \
    test -x /opt/llama/llama-server; \
    if LD_LIBRARY_PATH=/opt/llama ldd /opt/llama/llama-server | grep -q 'not found'; then \
      echo 'llama-server has unresolved shared libraries:'; \
      LD_LIBRARY_PATH=/opt/llama ldd /opt/llama/llama-server; \
      exit 1; \
    fi

ENV PATH=/opt/llama:$PATH \
    LD_LIBRARY_PATH=/opt/llama

WORKDIR /app
COPY --from=build /app/dist/index.js /app/dist/index.js
COPY package.json ./

# The runner mounts the workspace at /github/workspace and sets it as CWD.
# tini reaps zombies so a stopped llama-server never leaves a stray child, and
# so the fetch/undici handles don't hang the action.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/index.js"]
