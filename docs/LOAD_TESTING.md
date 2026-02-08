# Load Testing – Simulating WebSocket Traffic

Ways to simulate traffic and test your WebSocket server under load.

---

## 1. Built-in Node.js script (recommended)

A script in `scripts/load-test.js` connects many Socket.IO clients and sends `draw_op` messages.

### Install client dependency

```bash
npm install --save-dev socket.io-client
```

### Start your server

```bash
# Terminal 1
npm run dev
# or: npm run start:prod
```

### Run the load test

```bash
# Terminal 2 – default: 50 clients, 30s, 5 ops/client/s
npm run load-test
```

### Configure via environment variables

| Variable       | Default            | Description                          |
|---------------|--------------------|-------------------------------------|
| `WS_URL`      | `http://localhost:3000` | Server URL                      |
| `CLIENTS`     | `50`               | Number of concurrent clients        |
| `DURATION_SEC`| `30`               | How long to run (seconds)           |
| `OPS_PER_SEC` | `5`                | Draw ops per client per second      |

Examples:

```bash
# Light load
CLIENTS=20 OPS_PER_SEC=2 npm run load-test

# Medium load
CLIENTS=100 OPS_PER_SEC=5 npm run load-test

# Heavy load (will hit rate limits)
CLIENTS=200 OPS_PER_SEC=15 npm run load-test

# Long run
DURATION_SEC=120 CLIENTS=50 npm run load-test

# Different server
WS_URL=http://localhost:3001 npm run load-test
```

### What the script does

- Connects `CLIENTS` Socket.IO clients to `WS_URL`
- Each client gets a room (`room_assigned`)
- Each client sends `draw_op` at `OPS_PER_SEC` per second
- Counts: connected, sent ops, received ops, batches, rate limits, errors
- Prints live stats and final summary

Use the **rate limited** and **errors** counts to see how your server behaves under load.

---

## 2. Artillery (optional)

[Artillery](https://www.artillery.io/) can run WebSocket scenarios. You need the Socket.IO engine.

### Install

```bash
npm install -g artillery
npm install -g artillery-engine-socketio
```

### Run

```bash
# Basic run (edit script to match your server URL if needed)
artillery run scripts/artillery-websocket.yml
```

Artillery’s Socket.IO support and YAML format may differ; use the Node script above for a reliable, project-specific load test.

---

## 3. Manual testing with multiple browser tabs

1. Open your frontend in several tabs (e.g. 10–20).
2. Draw in each tab.
3. Watch server logs and Redis for connection count, rooms, and rate limits.

---

## 4. k6 (optional)

[k6](https://k6.io/) supports WebSockets and can run from a script.

### Install

```bash
# e.g. macOS
brew install k6
```

### Example script (`scripts/k6-ws.js`)

```javascript
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '30s',
};

export default function () {
  const url = 'http://localhost:3000';
  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'draw_op', payload: { /* ... */ } }));
    });
    socket.setTimeout(() => socket.close(), 10000);
  });
  check(res, { 'status 101': (r) => r && r.status === 101 });
}
```

k6’s WebSocket API is generic; Socket.IO’s handshake and protocol are different, so the Node.js script is a better fit for this app.

---

## Quick checklist

1. Install: `npm install --save-dev socket.io-client`
2. Start server: `npm run dev` (or prod)
3. Run: `npm run load-test`
4. Try: `CLIENTS=100 OPS_PER_SEC=10 npm run load-test` and watch rate limits and errors

For more on scaling and production, see [SCALING_GUIDE.md](./SCALING_GUIDE.md).
