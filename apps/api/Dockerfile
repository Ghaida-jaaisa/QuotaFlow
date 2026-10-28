# Build context: repository root (see docker-compose.yml).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @quotaflow/api

FROM deps AS build
COPY apps/api apps/api
RUN npm run build --workspace @quotaflow/api

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @quotaflow/api --omit=dev && mkdir -p apps/api/node_modules

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./node_modules
COPY apps/api/package.json ./
COPY apps/api/drizzle ./drizzle
COPY --from=build /app/apps/api/dist ./dist
USER node
EXPOSE 3000
# The same image runs migrations (`node dist/db/migrate.js`) as a one-shot service.
CMD ["node", "dist/server.js"]
