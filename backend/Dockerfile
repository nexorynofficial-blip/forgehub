# ForgeHub backend — multi-stage build.
# Stages share the same base so the toolchain version can only be set once.

FROM node:22-alpine AS base
WORKDIR /app
# OpenSSL is required by Prisma's query engine on Alpine.
RUN apk add --no-cache openssl

# ── deps: production-only modules, cached independently of source ────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── build: full toolchain, compiles TS and generates the Prisma client ───
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
# Generate before compiling: the client's types are imported by src.
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime: minimal image, non-root ─────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
# The generated Prisma client lives in node_modules and is not reproducible
# from the pruned deps stage, so copy it from build.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY prisma ./prisma

# `node` (uid 1000) ships with the base image; never run the app as root.
USER node

EXPOSE 4000

# Compose defines the real healthcheck; this keeps the image self-describing
# when run standalone.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
