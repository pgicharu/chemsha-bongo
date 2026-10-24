# Two-stage build: Vite builds the front end; the runtime image ships only
# production dependencies and the built assets.

FROM node:24.21.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY web ./web
RUN npm run build

FROM node:24.21.0-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY migrations ./migrations
# CLI scripts (chaos, bots, rescore) run inside this container.
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
# --import loads tracing.js first so OpenTelemetry can instrument later imports.
CMD ["node", "--import", "./src/tracing.js", "src/server.js"]
