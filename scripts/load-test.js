/**
 * WebSocket load test – simulates many clients connecting and sending draw operations.
 *
 * Usage:
 *   node scripts/load-test.js [options]
 *
 * Options (env or defaults):
 *   WS_URL          Server URL (default: http://localhost:3000)
 *   CLIENTS         Number of concurrent clients (default: 50)
 *   DURATION_SEC    How long to run in seconds (default: 30)
 *   OPS_PER_SEC     Draw ops per client per second (default: 5)
 *
 * Examples:
 *   node scripts/load-test.js
 *   CLIENTS=200 OPS_PER_SEC=10 node scripts/load-test.js
 *   WS_URL=http://localhost:3001 DURATION_SEC=60 node scripts/load-test.js
 */

const { io } = require('socket.io-client');

const WS_URL = process.env.WS_URL || 'http://localhost:3000';
const CLIENTS = parseInt(process.env.CLIENTS || '50', 10);
const DURATION_SEC = parseInt(process.env.DURATION_SEC || '30', 10);
const OPS_PER_SEC = parseFloat(process.env.OPS_PER_SEC || '5');

const stats = {
  connected: 0,
  disconnected: 0,
  errors: 0,
  rateLimitHits: 0,
  drawOpsSent: 0,
  drawOpsReceived: 0,
  drawOpBatchesReceived: 0,
  roomAssigned: 0,
};

function makeDrawOp(clientId, seq) {
  return {
    id: `op-${clientId}-${seq}-${Date.now()}`,
    playerId: clientId,
    type: 'pencil',
    timestamp: Date.now(),
    data: {
      path: [
        { x: Math.random() * 800, y: Math.random() * 600 },
        { x: Math.random() * 800, y: Math.random() * 600 },
      ],
      color: '#000000',
      size: 2,
    },
  };
}

function createClient(id) {
  const socket = io(WS_URL, {
    transports: ['websocket', 'polling'],
    query: { current_page: 'load-test' },
    reconnection: true,
    reconnectionAttempts: 3,
    timeout: 10000,
  });

  let drawInterval = null;
  let opSeq = 0;

  socket.on('connect', () => {
    stats.connected++;
  });

  socket.on('disconnect', (reason) => {
    stats.disconnected++;
    if (drawInterval) clearInterval(drawInterval);
  });

  socket.on('connect_error', (err) => {
    stats.errors++;
  });

  socket.on('room_assigned', () => {
    stats.roomAssigned++;
  });

  socket.on('canvas_state', () => {
    // Started receiving; can count if needed
  });

  socket.on('user_joined', () => {});
  socket.on('user_left', () => {});

  socket.on('draw_op', () => {
    stats.drawOpsReceived++;
  });

  socket.on('draw_op_batch', (data) => {
    stats.drawOpBatchesReceived++;
    stats.drawOpsReceived += (data.operations || []).length;
  });

  socket.on('rate_limit_exceeded', () => {
    stats.rateLimitHits++;
  });

  socket.on('error', () => {
    stats.errors++;
  });

  // Start sending draw ops after a short delay (allow room_assigned first)
  socket.once('room_assigned', () => {
    const intervalMs = Math.max(100, Math.floor(1000 / OPS_PER_SEC));
    drawInterval = setInterval(() => {
      if (!socket.connected) return;
      const op = makeDrawOp(socket.id, ++opSeq);
      socket.emit('draw_op', op);
      stats.drawOpsSent++;
    }, intervalMs);
  });

  return socket;
}

function printStats() {
  const elapsed = (Date.now() - startTime) / 1000;
  process.stdout.write(
    `\r[${elapsed.toFixed(1)}s] ` +
      `conn: ${stats.connected} | ` +
      `sent: ${stats.drawOpsSent} | ` +
      `recv: ${stats.drawOpsReceived} (batches: ${stats.drawOpBatchesReceived}) | ` +
      `rate-limited: ${stats.rateLimitHits} | ` +
      `errors: ${stats.errors}    `
  );
}

let startTime;
const sockets = [];

async function main() {
  console.log('WebSocket load test');
  console.log('==================');
  console.log(`URL:        ${WS_URL}`);
  console.log(`Clients:    ${CLIENTS}`);
  console.log(`Duration:   ${DURATION_SEC}s`);
  console.log(`Ops/client: ${OPS_PER_SEC}/s`);
  console.log('');

  // Connect clients in waves to avoid thundering herd
  const waveSize = Math.min(20, CLIENTS);
  for (let i = 0; i < CLIENTS; i++) {
    sockets.push(createClient(i));
    if ((i + 1) % waveSize === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  startTime = Date.now();
  const statsInterval = setInterval(printStats, 500);

  // Run for DURATION_SEC
  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000));

  clearInterval(statsInterval);
  printStats();
  console.log('\n');

  // Disconnect all
  console.log('Disconnecting...');
  sockets.forEach((s) => s.disconnect());
  await new Promise((r) => setTimeout(r, 2000));

  console.log('\nFinal stats:');
  console.log('  Connected:      ', stats.connected);
  console.log('  Disconnected:   ', stats.disconnected);
  console.log('  Draw ops sent:  ', stats.drawOpsSent);
  console.log('  Draw ops recv:  ', stats.drawOpsReceived);
  console.log('  Batches recv:   ', stats.drawOpBatchesReceived);
  console.log('  Rate limited:   ', stats.rateLimitHits);
  console.log('  Errors:         ', stats.errors);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
