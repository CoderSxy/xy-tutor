# Build on a development/CI machine, then transfer the images to ECS.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm exec tsc --ignoreConfig --outDir dist/admin --module NodeNext --moduleResolution NodeNext --target ES2023 --esModuleInterop --skipLibCheck scripts/create-admin.ts
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node packages/db/migrations ./dist/server/packages/db/migrations
USER node
EXPOSE 3001
CMD ["node", "dist/server/apps/server/src/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile

# Runs pg_dump/pg_restore inside the private network, matching PG17.
FROM postgres:17-bookworm AS ops
WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/node_modules ./node_modules
COPY scripts/backup-db.mjs scripts/restore-db.mjs scripts/pg-process.mjs ./scripts/
RUN mkdir /work && chown postgres:postgres /work && node --version
ENV TMPDIR=/work
USER postgres
ENTRYPOINT ["node"]
CMD ["scripts/backup-db.mjs"]
