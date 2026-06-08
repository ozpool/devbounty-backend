# syntax=docker/dockerfile:1

# ---- build: install every workspace and compile the API to dist/ ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY contracts/package.json ./contracts/
# --ignore-scripts skips husky and the mongodb-memory-server binary download,
# neither of which belongs in an image build.
RUN npm ci --ignore-scripts
COPY . .
RUN npm -w @devbounty/api run build

# ---- runtime: production dependencies and the compiled output only ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY contracts/package.json ./contracts/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/api/dist ./api/dist
# Drop root: run as the unprivileged `node` user baked into the base image.
USER node
EXPOSE 4000
# Liveness probe for plain `docker run`/compose (Render uses its own HTTP check).
# /health is dependency-free, so a DB/RPC blip won't flap the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Default entrypoint is the API. The indexer reuses this image with the command
# `node api/dist/indexer/index.js` (see docker-compose.yml).
CMD ["node", "api/dist/index.js"]
