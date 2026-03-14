import { OnApplicationBootstrap } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { MouseService, type Operation } from './mouse.service';
import { RoomService } from './room.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';
import { MessageThrottleService } from './message-throttle.service';
import {
  validateDrawOp,
  validateMovePointer,
  validateResetOps,
  sanitizePointerData,
} from './validation';

@WebSocketGateway({
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3,
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024,
    },
    threshold: 1024,
  },
})
export class MouseGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnApplicationBootstrap
{
  @WebSocketServer()
  server: Server;

  private static readonly TTL_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
  private lastTTLRefresh = new Map<string, number>();

  constructor(
    private readonly mouseService: MouseService,
    private readonly roomService: RoomService,
    private readonly redisService: RedisService,
    private readonly rateLimitService: RateLimitService,
    private readonly messageThrottleService: MessageThrottleService,
  ) {}

  afterInit(_server: Server) {}

  onApplicationBootstrap() {
    const pubClient = this.redisService.getPubClient();
    const subClient = this.redisService.getSubClient();
    if (!pubClient || !subClient) {
      console.warn(
        'Socket.IO Redis adapter skipped: Redis clients not available',
      );
      return;
    }
    this.server.adapter(createAdapter(pubClient, subClient));
    console.log('Socket.IO Redis adapter initialized for horizontal scaling');
  }

  /**
   * Re-assign a connected client to a new room after their previous room
   * expired in Redis. Leaves stale Socket.IO rooms, creates a fresh room,
   * and sends the full init sequence so the frontend updates seamlessly.
   */
  private async reassignToRoom(client: Socket): Promise<string> {
    for (const room of client.rooms) {
      if (room !== client.id) client.leave(room);
    }

    const currentPage =
      (client.handshake.query.current_page as string) || 'home';
    const roomId = await this.roomService.getOrCreateRoomForUser(client.id);
    client.join(roomId);

    const user = await this.mouseService.createUser(
      client.id,
      currentPage,
      roomId,
    );

    this.lastTTLRefresh.set(roomId, Date.now());
    await this.mouseService.refreshRoomTTLs(roomId);

    const canvasState = await this.mouseService.getCanvasState(roomId);
    client.emit('canvas_state', { operations: canvasState });
    client.emit('room_assigned', { roomId });
    client.emit('init', user);

    const usersInRoom = (
      await this.mouseService.getUsersInRoom(roomId)
    ).filter((u) => u.id !== client.id);
    client.emit('current_users', usersInRoom);
    this.server.to(roomId).emit('user_joined', user);

    console.log(
      `User ${client.id} reassigned to room ${roomId} after expiration`,
    );
    return roomId;
  }

  /**
   * Refresh TTLs for a room at most once per TTL_REFRESH_INTERVAL_MS.
   * Called on every user activity so long-running sessions never expire.
   */
  private async maybeRefreshTTLs(roomId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastTTLRefresh.get(roomId) ?? 0;
    if (now - last < MouseGateway.TTL_REFRESH_INTERVAL_MS) return;
    this.lastTTLRefresh.set(roomId, now);
    await this.mouseService.refreshRoomTTLs(roomId);
  }

  /**
   * Get the user's current room, or reassign them if their room expired.
   * Also triggers a throttled TTL refresh to keep the room alive.
   */
  private async getOrReassignRoom(client: Socket): Promise<string> {
    const roomId = await this.roomService.getRoomIdForUser(client.id);
    if (roomId) {
      await this.maybeRefreshTTLs(roomId);
      return roomId;
    }
    return this.reassignToRoom(client);
  }

  async handleConnection(client: Socket) {
    try {
      const currentPage =
        (client.handshake.query.current_page as string) || 'home';
      const roomId = await this.roomService.getOrCreateRoomForUser(client.id);
      client.join(roomId);

      const user = await this.mouseService.createUser(
        client.id,
        currentPage,
        roomId,
      );
      const roomSize = await this.roomService.getRoomSize(roomId);
      console.log(
        `User connected: ${client.id} on page ${currentPage}, room ${roomId} (${roomSize}/5)`,
      );

      this.lastTTLRefresh.set(roomId, Date.now());
      await this.mouseService.refreshRoomTTLs(roomId);

      const canvasState = await this.mouseService.getCanvasState(roomId);
      client.emit('canvas_state', { operations: canvasState });
      client.emit('room_assigned', { roomId });
      client.emit('init', user);

      const usersInRoom = (
        await this.mouseService.getUsersInRoom(roomId)
      ).filter((u) => u.id !== client.id);
      client.emit('current_users', usersInRoom);
      this.server.to(roomId).emit('user_joined', user);
    } catch (error) {
      console.error('Error in handleConnection:', error);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    try {
      const roomId = await this.roomService.removeUserFromRoom(client.id);
      await this.rateLimitService.resetSocketLimits(client.id);
      this.messageThrottleService.flush(roomId || undefined);
      await this.mouseService.removeUser(client.id);
      console.log(`User disconnected: ${client.id}`);
      if (roomId) {
        this.server.to(roomId).emit('user_left', { id: client.id });
        const remaining = await this.roomService.getRoomSize(roomId);
        if (remaining === 0) this.lastTTLRefresh.delete(roomId);
      }
    } catch (error) {
      console.error('Error in handleDisconnect:', error);
    }
  }

  @SubscribeMessage('draw_op')
  async handleDrawOp(
    @ConnectedSocket() client: Socket,
    @MessageBody() op: Operation,
  ) {
    try {
      const validation = validateDrawOp(op, client.id);
      if (!validation.valid) {
        client.emit('error', { message: validation.reason });
        return;
      }

      // Enforce server-authoritative playerId
      op.playerId = client.id;

      const rateLimit = await this.rateLimitService.checkDrawOpLimit(client.id);
      if (!rateLimit.allowed) {
        client.emit('rate_limit_exceeded', {
          message: 'Too many requests. Please slow down.',
          resetAt: rateLimit.resetAt,
        });
        return;
      }

      const roomId = await this.getOrReassignRoom(client);

      const roomLimitOk =
        await this.rateLimitService.checkRoomMessageLimit(roomId);
      if (!roomLimitOk) {
        console.warn(`Room ${roomId} message limit exceeded`);
        return;
      }

      if (typeof op.timestamp !== 'number') {
        op.timestamp = Date.now();
      }

      const batchedOps = await this.messageThrottleService.throttle(roomId, op);

      await this.mouseService.addOperations(roomId, batchedOps);

      if (batchedOps.length > 1) {
        this.server
          .to(roomId)
          .emit('draw_op_batch', { operations: batchedOps });
      } else {
        this.server.to(roomId).emit('draw_op', batchedOps[0]);
      }
    } catch (error) {
      console.error('Error in handleDrawOp:', error);
      client.emit('error', { message: 'Failed to process draw operation' });
    }
  }

  @SubscribeMessage('reset_my_ops')
  async handleResetOps(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string },
  ) {
    try {
      const validation = validateResetOps(data);
      if (!validation.valid) {
        client.emit('error', { message: validation.reason });
        return;
      }

      const roomId = await this.getOrReassignRoom(client);
      const userId = data?.userId || client.id;
      const canvasState = await this.mouseService.removeUserOperations(userId);
      this.server
        .to(roomId)
        .emit('user_ops_removed', { userId, canvas_state: canvasState });
    } catch (error) {
      console.error('Error in handleResetOps:', error);
      client.emit('error', { message: 'Failed to reset operations' });
    }
  }

  @SubscribeMessage('move_pointer')
  async handleMovePointer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      x: number;
      y: number;
      scrollX?: number;
      scrollY?: number;
      pageX?: number;
      pageY?: number;
      current_page: string;
    },
  ) {
    const validation = validateMovePointer(data);
    if (!validation.valid) return;

    const user = this.mouseService.getUser(client.id);
    const roomId = await this.getOrReassignRoom(client);
    const payload = {
      id: client.id,
      name: user?.name ?? '',
      color: user?.color ?? '#94A3B8',
      ...sanitizePointerData(data as Record<string, unknown>),
    };
    client.to(roomId).emit('pointer_moved', payload);
  }
}
