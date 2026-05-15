# Multi-stage build to keep the final image lean
FROM node:24-alpine AS deps

WORKDIR /usr/src/app

# Copy manifests first - this layer is cached unless deps change
COPY package*.json ./
RUN npm ci --omit=dev

# ---

FROM node:24-alpine AS runner

WORKDIR /usr/src/app

# Copy installed production deps from the deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy source code (blocklist/allowlist/data excluded via .dockerignore)
COPY . .

# Pre-create the data directory so the volume mount point exists
RUN mkdir -p /usr/src/app/data
VOLUME ["/usr/src/app/data"]

# Containers must listen on all interfaces for Docker port publishing to work
ENV HOST=0.0.0.0
ENV CZGS_DATA_DIR=/usr/src/app/data
ENV CZGS_ENV_PATH=/usr/src/app/data/.env

EXPOSE 3333

CMD ["npm", "run", "web"]
