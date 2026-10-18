# syntax=docker/dockerfile:1

FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b AS bun

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

COPY . .
RUN npm run build

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS production-dependencies
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The untrusted-code container contains only the pinned runtime dependencies
# and the small trusted build wrapper. It does not contain app code, projects,
# deployment configuration, or runner credentials.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build-job
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/server/build-job.js ./dist/server/build-job.js
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["node", "/app/dist/server/build-job.js"]

# Keep the application runtime as the default target for ordinary `docker build`.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PROJECTS_DIR=/data/projects \
    HOME=/tmp \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/examples ./examples

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && mkdir -p /data/projects \
    && chown -R node:node /data
USER node

EXPOSE 3000
VOLUME ["/data/projects"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/index.js"]
