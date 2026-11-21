FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY print-agent/package.json print-agent/package.json
RUN npm ci --no-audit --no-fund
COPY frontend frontend
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-noto-core poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /var/lib/kiosk
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/frontend/package.json frontend/package.json
COPY --from=build /app/print-agent/package.json print-agent/package.json
RUN npm ci --workspace kiosk-backend --omit=dev --no-audit --no-fund
COPY backend/src backend/src
COPY backend/migrations backend/migrations
COPY --from=build /app/frontend/dist frontend/dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/lib/kiosk XDG_CACHE_HOME=/tmp/.cache
USER node
EXPOSE 3000
CMD ["node", "backend/src/server.js"]
