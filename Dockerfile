FROM node:22-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches this Node version.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# A failing check fails the build, so Railway keeps serving the last good deploy.
RUN npm run typecheck && npm test
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/data/wicket.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY package.json ./
EXPOSE 4318
CMD ["node", "dist/src/index.js"]
