FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependency specifications
COPY package.json pnpm-lock.yaml ./

# Install all dependencies including devDependencies (needed for ncc build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/

# Build single-file production bundle dist/index.js
RUN pnpm build

# Production image
FROM node:22-alpine AS runner

WORKDIR /app

# Copy built artifact and package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Expose HTTP control port
EXPOSE 2525

# Start service
CMD ["node", "dist/index.js"]
