# Testing the server locally

## Prerequisites

- **Node.js** (v18+)
- **pnpm** (`npm install -g pnpm`)
- **Redis** (used for WebSocket rooms and pub/sub)

## 1. Environment

Config is loaded from `.env.local` then `.env` (see `ConfigModule` in `app.module.ts`).

Copy the example and edit if needed:

```bash
cp .env.example .env
# or .env.local (takes precedence, and is gitignored)
```

Optional variables:

| Variable    | Default                   | Description        |
|------------|---------------------------|--------------------|
| `PORT`     | `3000`                    | HTTP server port   |
| `REDIS_URL`| `redis://localhost:6379`  | Redis connection   |

## 2. Start Redis

The app expects Redis on `localhost:6379` unless you set `REDIS_URL`.

**Docker Compose (recommended):**

```bash
docker compose up -d redis
# or: pnpm run redis:up
```

Stops with `docker compose down` (or `pnpm run redis:down`). Data is kept in a volume. Logs: `pnpm run redis:logs`.

**One-off container:**

```bash
docker run -d --name wtf-redis -p 6379:6379 redis:7-alpine
```

**System Redis:**

```bash
redis-server
```

## 3. Install and run the server

```bash
pnpm install
pnpm run dev
```

- **`pnpm run dev`** – start with watch (recommended for local dev)
- **`pnpm run start`** – single run, no watch
- **`pnpm run start:debug`** – start with Node inspector

Server listens on `http://localhost:3000` (or your `PORT`). Root route returns `Hello World!`.

## 4. Run tests

**Unit tests** (no Redis required if modules under test don’t connect):

```bash
pnpm run test
```

**E2E tests** (use full `AppModule`, so **Redis must be running**):

```bash
pnpm run test:e2e
```

**Coverage:**

```bash
pnpm run test:cov
```

## 5. Load testing (optional)

See `LOAD_TESTING.md`. Requires the server to be running and uses the WebSocket endpoint.

## Quick checklist

1. Redis running on `localhost:6379` (or `REDIS_URL` set).
2. `.env` or `.env.local` in project root (optional; defaults work for local).
3. `pnpm run dev` to run the server.
4. `pnpm run test:e2e` to run e2e tests (with Redis up).
