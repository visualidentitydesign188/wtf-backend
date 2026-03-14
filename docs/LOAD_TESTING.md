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

## 2. Artillery stress test (recommended for capacity)

[Artillery](https://www.artillery.io/) is set up with the Socket.IO v3/v4 engine to validate **room creation**, **user assignment**, and **target load** (e.g. 5000 concurrent users).

### Install (included in devDependencies)

```bash
pnpm install
# artillery + artillery-engine-socketio-v3 are already in package.json
```

### What the stress test checks

- **Rooms created:** Each virtual user connects with `current_page: load-test`; the server creates or reuses rooms and emits `room_assigned`.
- **Users assigned:** If assignment failed, a later `draw_op` would trigger the server to emit `error` (“Not assigned to a room”) and the scenario would fail. Successful completion implies assignment worked.
- **Load:** Artillery reports connection count, emit rate, latency (p50/p95/p99), and errors so you can see if the server handles the target number of users.

### Run

```bash
# Start backend (and Redis) first, then:
npm run stress-test
```

- **Local:** default target is `http://localhost:3001` (no flag needed).
- **Deployed server:** run with the `deployed` environment:
  ```bash
  npm run stress-test -- -e deployed
  npm run stress-test:report -- -e deployed
  ```

**Where to set the deployed URL:** In `scripts/artillery-stress.yml`, under `config.environments.deployed.target`. Change `https://allthingswtf.com` to your real domain. You can add more environments (e.g. `staging`) the same way.

To tune load, edit `scripts/artillery-stress.yml` and change the `arrivalRate` in the `phases` (default 80), or override via Artillery:

```bash
npx artillery run scripts/artillery-stress.yml --overrides '{"config":{"phases":[{"duration":60,"arrivalRate":40,"name":"Ramp up"},{"duration":120,"arrivalRate":40,"name":"Sustained"}]}}'
```

### HTML report

```bash
npm run stress-test:report              # test local, then generate report
npm run stress-test:report -- -e deployed   # test deployed server, then generate report
```

Writes `reports/stress-report.json` and `reports/stress-report.html`. Open the HTML file in a browser for charts and metrics. The same `-e` flag is passed to the test run, so use `-e deployed` when testing the deployed server.

### Scenario file

- **`scripts/artillery-stress.yml`** – Phases: 60s ramp, 120s sustain. Each virtual user: connect → wait 2s (for `room_assigned`, etc.) → send 30 `draw_op` messages with 1s think between each.

---

## 3. Artillery quick run (legacy scenario)

For a short run with the older scenario file:

```bash
artillery run scripts/artillery-websocket.yml
```

Override URL: `WS_URL=http://localhost:3001 artillery run scripts/artillery-websocket.yml`. Prefer `npm run stress-test` and `scripts/artillery-stress.yml` for room/assignment and target-load testing.

---

## 4. Manual testing with multiple browser tabs

1. Open your frontend in several tabs (e.g. 10–20).
2. Draw in each tab.
3. Watch server logs and Redis for connection count, rooms, and rate limits.

---

## 5. k6 (optional)

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

1. Install: `pnpm install` (includes socket.io-client and Artillery + socketio-v3 engine)
2. Start server: `npm run dev` (or prod) and ensure Redis is running
3. **Load test (Node):** `npm run load-test` — try `CLIENTS=100 OPS_PER_SEC=10 npm run load-test`
4. **Stress test (Artillery):** `npm run stress-test` — validates rooms, assignment, and load; use `npm run stress-test:report` for an HTML report

For more on scaling and production, see [SCALING_GUIDE.md](./SCALING_GUIDE.md).
