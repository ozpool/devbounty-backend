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
EXPOSE 4000
# Default entrypoint is the API. The indexer reuses this image with the command
# `node api/dist/indexer/index.js` (see docker-compose.yml).
CMD ["node", "api/dist/index.js"]
