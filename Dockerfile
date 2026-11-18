# syntax=docker/dockerfile:1

# --- Stage 1: Build Frontend (Vite) & Server (TypeScript) + Native Addons ---
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json tsconfig.electron.json vite.config.ts index.html ./
COPY src ./src
COPY electron ./electron

RUN npm run build:server && npx vite build && npm prune --omit=dev

# --- Stage 2: Minimal Headless rTunes-Server Runtime ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    RTUNES_DATA_DIR=/config \
    RTUNES_MEDIA_DIR=/media

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-electron ./dist-electron

RUN mkdir -p /config /media /app/.data && chmod 0777 /config /app/.data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-electron/server.js"]
