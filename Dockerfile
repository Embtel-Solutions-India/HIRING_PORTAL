# ---------- 1. Build the React app ----------
FROM node:24-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. Runtime: Node API that also serves the built app ----------
FROM node:24-slim
ENV NODE_ENV=production \
    FRONTEND_DIST=/app/frontend/dist \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app/backend
# Prisma's migration engine (run on startup) needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json backend/prisma.config.ts ./
COPY backend/prisma ./prisma
# postinstall runs `prisma generate` into src/generated
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/src ./src
# The permission matrix (and its types) are shared with the frontend.
COPY frontend/package.json /app/frontend/package.json
COPY frontend/src/lib/permissions.ts /app/frontend/src/lib/permissions.ts
COPY frontend/src/types.ts /app/frontend/src/types.ts
COPY --from=web /app/frontend/dist /app/frontend/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.ts"]
