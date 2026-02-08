# Frontend integration – wtf-backend API reference

Single source of truth for integrating a frontend (Vue, React, Svelte, etc.) with the wtf-backend. Use this when generating or modifying client code that calls this backend.

---

## 1. Base configuration

### 1.1 Base URL and WebSocket URL

| Environment | HTTP API base URL | WebSocket URL |
|-------------|-------------------|---------------|
| Development | `http://localhost:3000` | `http://localhost:3000` (same origin) |
| Production | `https://your-api-domain.com` | `https://your-api-domain.com` (same origin) |

- Backend default port: **3000** (overridable with `PORT`).
- Socket.IO is served on the **same host and port** as the HTTP server; do not use a path like `/socket.io` in the base URL—the client library adds that.

### 1.2 Frontend environment variables

Define these in the frontend (e.g. `.env`, `.env.local`, or Vite `import.meta.env`):

```bash
# Required: backend base URL (no trailing slash)
VITE_API_URL=http://localhost:3000
# Or for Create React App / Next.js:
# REACT_APP_API_URL=http://localhost:3000
# NEXT_PUBLIC_API_URL=http://localhost:3000
```

- **HTTP requests:** use `VITE_API_URL` (or equivalent) as the base.
- **WebSocket:** connect to the same URL; Socket.IO will use `VITE_API_URL` as the base (same origin in production if frontend is on same domain, or explicit for cross-origin).

### 1.3 CORS

- Backend Socket.IO gateway allows `origin: '*'` by default.
- If the frontend is on a different domain, ensure the Nest HTTP app has CORS enabled for that origin (see backend `main.ts` / `enableCors`). Same-origin deployments need no extra CORS for the API.

---

## 2. HTTP API

All responses are plain JSON unless noted. Base path prefix: none for root, `/mouse` for mouse endpoints.

### 2.1 Endpoints

| Method | Path | Description | Request body | Response |
|--------|------|-------------|--------------|----------|
| GET | `/` | Health / hello | — | `"Hello World!"` (string) |
| GET | `/mouse` | Mouse module status | — | `"Mouse is active"` (string) |
| GET | `/mouse/users` | Example user list (placeholder) | — | `["user1", "user2", "user3"]` (string[]) |

### 2.2 Example: fetch

```typescript
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// GET /
const res = await fetch(`${API_URL}/`);
const text = await res.text(); // "Hello World!"

// GET /mouse
const status = await fetch(`${API_URL}/mouse`).then((r) => r.text()); // "Mouse is active"

// GET /mouse/users
const users = await fetch(`${API_URL}/mouse/users`).then((r) => r.json()); // string[]
```

---

## 3. WebSocket (Socket.IO)

The backend uses **Socket.IO** for real-time canvas and presence. One namespace (default `/`); path is managed by the library.

### 3.1 Connection URL and options

- **URL:** same as HTTP base (e.g. `http://localhost:3000` or `https://your-api-domain.com`).
- **Query parameters (optional):** pass `current_page` so the server can associate the connection with a page.

Recommended client options (align with server limits):

```typescript
import { io } from 'socket.io-client';

const WS_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const socket = io(WS_URL, {
  transports: ['websocket', 'polling'],
  query: {
    current_page: 'home', // or your route name, e.g. 'editor', 'canvas'
  },
});
```

### 3.2 Connection lifecycle (server behavior)

- On connect, the server assigns the socket to a **room** (max 5 users per room), creates a **user** record, and sends initial events to this client only.
- On disconnect, the server removes the user from the room and notifies the room.

---

## 4. Server → Client events (listen on `socket.on(...)`)

These are emitted **by the backend** to the connected client. The frontend must subscribe with `socket.on('eventName', (payload) => { ... })`.

| Event name | When | Payload type | Description |
|------------|------|--------------|-------------|
| `canvas_state` | Once, right after connection | `{ operations: Operation[] }` | Full canvas state for the room. Apply these operations to init the canvas. |
| `room_assigned` | Once, right after connection | `{ roomId: string }` | Room id for this socket. Use for display or debugging. |
| `user_joined` | When another user joins the same room | `UserPointer` | New user in the room (presence). |
| `user_left` | When a user in the room disconnects | `{ id: string }` | Socket id of the user who left. |
| `draw_op` | When a single draw operation is applied in the room | `Operation` | One drawing operation to apply. |
| `draw_op_batch` | When multiple operations are applied at once | `{ operations: Operation[] }` | Batch of operations to apply in order. |
| `user_ops_removed` | When someone’s operations are reset | `{ userId: string; canvas_state: Operation[] }` | Who was reset and the new canvas state after reset. |
| `rate_limit_exceeded` | When this client sends too many draw ops | `{ message: string; resetAt: number }` | Throttle UI or backoff until `resetAt` (ms). |
| `error` | On various errors (e.g. not in room, draw failed) | `{ message: string }` | Show or log the error. |

### 4.1 TypeScript types (server → client payloads)

```typescript
// Operation type and shape (must match backend)
export type OperationType = 'pencil' | 'sprayPaint' | 'fillColor' | 'eraser';

export interface Operation {
  id: string;
  playerId: string;
  type: OperationType;
  timestamp: number;
  sequence?: number;
  data: {
    path?: Array<{ x: number; y: number }>;
    sprayPoints?: Array<{ x: number; y: number }>;
    fillPoint?: { x: number; y: number };
    targetColor?: string;
    fillColor?: string;
    color?: string;
    backgroundColor?: string;
    size?: number;
    fillResult?: unknown;
  };
}

export interface UserPointer {
  id: string;
  name: string;
  color: string;
  current_page: string;
  roomId: string;
  x: number;
  y: number;
  scrollX?: number;
  scrollY?: number;
  pageX?: number;
  pageY?: number;
  lastDrawAt?: number;
}

// Event payload types (what the server sends)
interface CanvasStatePayload {
  operations: Operation[];
}
interface RoomAssignedPayload {
  roomId: string;
}
interface UserLeftPayload {
  id: string;
}
interface DrawOpBatchPayload {
  operations: Operation[];
}
interface UserOpsRemovedPayload {
  userId: string;
  canvas_state: Operation[];
}
interface RateLimitExceededPayload {
  message: string;
  resetAt: number;
}
interface ErrorPayload {
  message: string;
}
```

---

## 5. Client → Server events (emit with `socket.emit(...)`)

The frontend **sends** these events to the backend. Payloads must match the shapes below.

### 5.1 Events and payloads

| Event name | Payload | Description |
|------------|---------|-------------|
| `draw_op` | `Operation` | Append one drawing operation. Required fields: `id`, `playerId`, `type`; `timestamp` can be omitted (server sets it). |
| `reset_my_ops` | `{ userId?: string }` | Remove all operations for `userId` (default: current socket id). Optional body: `{}` or `{ userId: "some-id" }`. |

### 5.2 Validation (backend)

- **draw_op:** backend ignores ops missing `id`, `playerId`, or `type`. It may emit `rate_limit_exceeded` or `error` if limits are hit or the client is not in a room.
- **reset_my_ops:** if the socket is not in a room, server emits `error` with message `"Not assigned to a room"`.

### 5.3 Example: sending a draw operation

```typescript
const op: Operation = {
  id: crypto.randomUUID(),
  playerId: socket.id,
  type: 'pencil',
  timestamp: Date.now(),
  data: {
    path: [{ x: 10, y: 20 }, { x: 15, y: 25 }],
    color: '#000000',
    size: 2,
  },
};
socket.emit('draw_op', op);
```

### 5.4 Example: reset operations

```typescript
socket.emit('reset_my_ops', {}); // reset current user's ops
// or
socket.emit('reset_my_ops', { userId: 'some-socket-id' });
```

---

## 6. Recommended frontend flow

1. **Connect:** `io(WS_URL, { query: { current_page: '...' } })`.
2. **Listen first:** register `canvas_state`, `room_assigned`, `draw_op`, `draw_op_batch`, `user_joined`, `user_left`, `user_ops_removed`, `rate_limit_exceeded`, `error` before or right after connect.
3. **On `canvas_state`:** replace or init local canvas state with `payload.operations`.
4. **On `draw_op` / `draw_op_batch`:** append operation(s) to local state and redraw.
5. **On `user_ops_removed`:** update local state to `payload.canvas_state` and redraw.
6. **On `user_joined` / `user_left`:** update presence list/cursors.
7. **On `rate_limit_exceeded`:** disable or throttle send UI until `resetAt`.
8. **Send draws:** `socket.emit('draw_op', op)` with a valid `Operation`.
9. **Reset:** `socket.emit('reset_my_ops', {})` or `{ userId }`.

---

## 7. Limits and behavior (for implementation)

- **Room size:** up to 5 users per room; server assigns rooms automatically.
- **Rate limits:** per-socket draw-op limits (e.g. 10/sec, 60/min); server responds with `rate_limit_exceeded` when exceeded.
- **Room message limit:** server may drop draw ops if the room exceeds its message rate; no separate client event, so rely on `draw_op`/`draw_op_batch` not arriving if you throttle on `rate_limit_exceeded`.
- **Batching:** server may coalesce multiple `draw_op` sends into one `draw_op_batch`; always support both `draw_op` (single) and `draw_op_batch` (array) when applying to the canvas.

---

## 8. Minimal runnable example (browser)

```typescript
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

const socket = io(API_URL, {
  transports: ['websocket', 'polling'],
  query: { current_page: 'home' },
});

socket.on('connect', () => console.log('Connected', socket.id));

socket.on('canvas_state', ({ operations }) => {
  console.log('Initial canvas state:', operations);
});

socket.on('room_assigned', ({ roomId }) => {
  console.log('Room:', roomId);
});

socket.on('draw_op', (op) => {
  console.log('Draw op:', op);
});

socket.on('draw_op_batch', ({ operations }) => {
  console.log('Draw batch:', operations);
});

socket.on('error', ({ message }) => console.error('Server error:', message));
socket.on('rate_limit_exceeded', (p) => console.warn('Rate limit:', p));

// Send one draw op
socket.emit('draw_op', {
  id: crypto.randomUUID(),
  playerId: socket.id,
  type: 'pencil',
  timestamp: Date.now(),
  data: { path: [{ x: 0, y: 0 }], color: '#000', size: 2 },
});
```

---

## 9. Checklist for AI agents / codegen

When generating or editing frontend code that uses this backend:

- [ ] Use the same **base URL** for both HTTP and Socket.IO (from env, e.g. `VITE_API_URL`).
- [ ] Connect with **query** `current_page` when relevant.
- [ ] Listen for: `canvas_state`, `room_assigned`, `user_joined`, `user_left`, `draw_op`, `draw_op_batch`, `user_ops_removed`, `rate_limit_exceeded`, `error`.
- [ ] Emit only: `draw_op` (with full `Operation`), `reset_my_ops` (with `{}` or `{ userId?: string }`).
- [ ] Use **snake_case** for server payloads: `roomId`, `canvas_state`, `resetAt`, etc., as defined in this doc.
- [ ] Implement handling for both **single** `draw_op` and **batch** `draw_op_batch`.
- [ ] Handle **rate_limit_exceeded** (e.g. disable send until `resetAt`).

---

*Backend: wtf-backend (NestJS + Socket.IO). This doc reflects the API as of the last update; align frontend types and event names with the backend source when in doubt.*
