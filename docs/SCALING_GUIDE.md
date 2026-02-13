# Scaling Guide for 5000 Concurrent Users

This guide explains the scaling implementation for handling 5000+ concurrent WebSocket connections.

## Architecture Overview

```
┌─────────────┐
│Load Balancer│ (nginx/HAProxy with sticky sessions)
└──────┬──────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐ ┌──▼──┐
│WS #1│ │WS #2│ ... (Multiple NestJS instances)
└──┬──┘ └──┬──┘
   │       │
   └───┬───┘
       │
   ┌───▼───┐
   │ Redis │ (Pub/Sub + State Storage)
   └───────┘
```

## Features Implemented

### 1. **Horizontal Scaling with Redis Adapter**
- Socket.IO Redis adapter enables broadcasting across multiple server instances
- Room state stored in Redis for shared access
- Supports unlimited horizontal scaling

### 2. **Rate Limiting**
- **Per-socket limits**: 10 ops/second, 60 ops/minute
- **Per-room limits**: 50 messages/second per room
- Prevents buffer overflow from too many requests
- Distributed rate limiting via Redis

### 3. **Message Throttling/Batching**
- Batches operations every 50ms or when batch reaches 20 operations
- Reduces message volume by up to 95%
- Automatically flushes on disconnect

### 4. **Optimized Buffer Configuration**
- Reduced `maxHttpBufferSize` from 2MB to 1MB
- Compression enabled for payloads > 1KB
- Connection timeouts and ping/pong configured

## Installation

### 1. Install Dependencies

```bash
npm install @socket.io/redis-adapter ioredis
```

### 2. Configure Redis

Set the Redis URL in your `.env` file:

```env
REDIS_URL=redis://localhost:6379
# Or for production:
REDIS_URL=redis://your-redis-host:6379
```

### 3. Start Redis

```bash
# Using Docker
docker run -d -p 6379:6379 redis:7-alpine

# Or install locally
# macOS: brew install redis && redis-server
# Ubuntu: sudo apt-get install redis-server && redis-server
```

## Deployment

### Single Instance (Development)

```bash
npm run start:prod
```

### Multiple Instances (Production)

1. **Start multiple instances** on different ports:
   ```bash
   PORT=3001 npm run start:prod &
   PORT=3002 npm run start:prod &
   PORT=3003 npm run start:prod &
   ```

2. **Configure Load Balancer** (nginx example):
   ```nginx
   upstream websocket_backend {
       ip_hash; # Sticky sessions
       server localhost:3001;
       server localhost:3002;
       server localhost:3003;
   }

   server {
       listen 80;
       location /socket.io/ {
           proxy_pass http://websocket_backend;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_connect_timeout 7d;
           proxy_send_timeout 7d;
           proxy_read_timeout 7d;
       }
   }
   ```

### Docker Compose (Recommended)

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  
  app1:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3001
    depends_on:
      - redis
  
  app2:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3002
    depends_on:
      - redis
  
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    depends_on:
      - app1
      - app2
```

## Rate Limits

### Current Limits (Configurable in `rate-limit.service.ts`)

- **Per Socket**: 10 draw operations/second, 60/minute
- **Per Room**: 50 messages/second
- **Buffer Size**: 1MB per message

### Adjusting Limits

Edit `src/mouse/rate-limit.service.ts`:

```typescript
private readonly DEFAULT_LIMITS = {
  drawOpPerMinute: 100, // Increase if needed
  drawOpPerSecond: 20,
  roomMessagesPerSecond: 100,
};
```

## Monitoring

### Connection Count

```typescript
// In your gateway or service
const sockets = await this.server.fetchSockets();
console.log(`Active connections: ${sockets.length}`);
```

### Redis Monitoring

```bash
# Monitor Redis commands
redis-cli MONITOR

# Check memory usage
redis-cli INFO memory

# Check connected clients
redis-cli CLIENT LIST
```

## Performance Tuning

### For 5000 Concurrent Users

1. **Redis Configuration** (`redis.conf`):
   ```
   maxmemory 2gb
   maxmemory-policy allkeys-lru
   ```

2. **Node.js Memory**:
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096" npm run start:prod
   ```

3. **OS Limits**:
   ```bash
   # Increase file descriptor limit
   ulimit -n 65536
   ```

4. **Load Balancer**:
   - Use sticky sessions (ip_hash or cookie-based)
   - Configure proper timeouts (7 days for WebSocket)
   - Enable health checks

## Troubleshooting

### "Redis connection failed"
- Check Redis is running: `redis-cli ping`
- Verify `REDIS_URL` in `.env`
- Check firewall rules

### "Rate limit exceeded" errors
- Increase limits in `rate-limit.service.ts`
- Check if clients are sending too many messages
- Monitor Redis for rate limit keys

### High memory usage
- Reduce `maxHttpBufferSize` further
- Enable compression
- Check for memory leaks in room cleanup

### Messages not reaching all clients
- Verify Redis adapter is connected
- Check all instances share same Redis
- Verify load balancer sticky sessions

## Frontend Updates

### New Events

1. **`rate_limit_exceeded`**: Emitted when rate limit is hit
   ```typescript
   socket.on('rate_limit_exceeded', (data) => {
     console.log('Rate limit exceeded, reset at:', data.resetAt);
   });
   ```

2. **`draw_op_batch`**: Emitted when multiple operations are batched
   ```typescript
   socket.on('draw_op_batch', (data) => {
     data.operations.forEach(op => {
       // Process each operation
     });
   });
   ```

### Error Handling

```typescript
socket.on('error', (error) => {
  console.error('Socket error:', error);
  // Handle reconnection
});
```

## Capacity Planning

### Estimated Capacity per Instance

- **Connections**: ~1000-2000 per instance (depends on CPU/memory)
- **Messages**: ~10,000 messages/second per instance
- **Memory**: ~100MB base + ~50KB per connection

### For 5000 Users

- **Recommended**: 3-5 instances
- **Redis**: 2GB+ memory
- **Load Balancer**: 1 instance (nginx/HAProxy)

## Security Considerations

1. **Rate Limiting**: Prevents DDoS and abuse
2. **Input Validation**: All operations validated before processing
3. **Connection Limits**: Per-room limits prevent flooding
4. **Redis Security**: Use password authentication in production:
   ```env
   REDIS_URL=redis://:password@host:6379
   ```

## Next Steps

1. Set up monitoring (Prometheus + Grafana)
2. Implement health check endpoints
3. Add connection metrics logging
4. Set up auto-scaling based on connection count
5. Implement graceful shutdown
