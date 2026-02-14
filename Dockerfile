# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
RUN corepack enable pnpm 2>/dev/null || true && \
  (pnpm install --frozen-lockfile 2>/dev/null || npm ci 2>/dev/null || npm install)

COPY . .
RUN npm run build

# Run stage
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* package-lock.json* yarn.lock* ./
RUN corepack enable pnpm 2>/dev/null || true && \
  (pnpm install --frozen-lockfile --prod 2>/dev/null || npm ci --omit=dev 2>/dev/null || npm install --omit=dev)

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/main"]
