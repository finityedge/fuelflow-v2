# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/
# Isolated node_modules keeps the virtual store inside node_modules/.pnpm so the
# multi-stage copy to the runner remains self-contained.
RUN sed -i 's/node-linker=hoisted/node-linker=isolated/' .npmrc && pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec tsc -p packages/shared/tsconfig.json
RUN pnpm exec prisma generate --schema apps/backend/prisma/schema.prisma
RUN pnpm exec tsc -p apps/backend/tsconfig.build.json

FROM node:22-alpine AS runner
RUN apk add --no-cache dumb-init ca-certificates
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/backend ./apps/backend
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/node_modules ./apps/backend/node_modules
WORKDIR /app/apps/backend
EXPOSE 3000
CMD ["dumb-init", "node", "dist/index.js"]
