# Build from the repository root: docker build -f apps/relay/Dockerfile -t obnixe-relay .
FROM node:22-alpine AS build
WORKDIR /repo
RUN npm install --global pnpm@11.20.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/relay/package.json apps/relay/
RUN pnpm install --frozen-lockfile --filter obnixe-relay
COPY apps/relay apps/relay
RUN pnpm --filter obnixe-relay build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /repo/apps/relay/dist/main.mjs ./main.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "main.mjs"]
