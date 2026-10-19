# Build stage: compile the TypeScript bundle.
FROM node:22-alpine AS build
WORKDIR /app

# Install with a lockfile when present for reproducible builds.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: minimal image, no build toolchain, non-root.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# ca-certificates is needed for outbound HTTPS to the GitHub and LLM APIs.
RUN apk add --no-cache ca-certificates tini

COPY --from=build /app/dist/index.js /app/dist/index.js
COPY package.json ./

# The runner mounts the workspace at /github/workspace and sets it as CWD.
# tini reaps zombies so the fetch/undici handles don't hang the action.
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/index.js"]
