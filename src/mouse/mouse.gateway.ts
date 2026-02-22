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

@WebSocketGateway({
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6, // Reduced to 1MB - use compression for large payloads
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  transports: ['websocket', 'polling'], // Allow fallback
  allowEIO3: true, // Backward compatibility
  // Connection limits
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3,
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024,
    },
    threshold: 1024, // Only compress if payload > 1KB
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

  constructor(
    private readonly mouseService: MouseService,
    private readonly roomService: RoomService,
    private readonly redisService: RedisService,
    private readonly rateLimitService: RateLimitService,
    private readonly messageThrottleService: MessageThrottleService,
  ) {}

  afterInit(_server: Server) {
    // Adapter is set in onApplicationBootstrap so Redis is ready (after all onModuleInit).
  }

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

  async handleConnection(client: Socket) {
    try {
      const currentPage =
        (client.handshake.query.current_page as string) || 'home';
      const roomId = await this.roomService.getOrCreateRoomForUser(client.id);
      client.join(roomId);

      const user = this.mouseService.createUser(client.id, currentPage, roomId);
      const roomSize = await this.roomService.getRoomSize(roomId);
      console.log(
        `User connected: ${client.id} on page ${currentPage}, room ${roomId} (${roomSize}/5)`,
      );

      const canvasState = this.mouseService.getCanvasState(roomId);
      client.emit('canvas_state', { operations: canvasState });
      client.emit('room_assigned', { roomId });
      // So the connecting client gets their own profile (name, color, etc.)
      client.emit('init', user);
      // So the connecting client sees users already in the room
      const usersInRoom = this.mouseService
        .getUsersInRoom(roomId)
        .filter((u) => u.id !== client.id);
      client.emit('current_users', usersInRoom);
      this.server.to(roomId).emit('user_joined', user);
    } catch (error) {
      console.error('Error in handleConnection:', error);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    try {
      this.mouseService.markUserDisconnected(client.id);
      const roomId = await this.roomService.removeUserFromRoom(client.id);
      await this.rateLimitService.resetSocketLimits(client.id);
      this.messageThrottleService.flush(roomId || undefined);
      this.mouseService.removeUser(client.id);
      console.log(`User disconnected: ${client.id}`);
      if (roomId) {
        this.server.to(roomId).emit('user_left', { id: client.id });
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
      if (!op?.id || !op?.playerId || !op?.type) {
        console.warn('Invalid operation received:', op);
        return;
      }

      // Rate limiting check
      const rateLimit = await this.rateLimitService.checkDrawOpLimit(client.id);
      if (!rateLimit.allowed) {
        client.emit('rate_limit_exceeded', {
          message: 'Too many requests. Please slow down.',
          resetAt: rateLimit.resetAt,
        });
        return;
      }

      const roomId = await this.roomService.getRoomIdForUser(client.id);
      if (!roomId) {
        client.emit('error', { message: 'Not assigned to a room' });
        return;
      }

      // Check room message limit
      const roomLimitOk =
        await this.rateLimitService.checkRoomMessageLimit(roomId);
      if (!roomLimitOk) {
        console.warn(`Room ${roomId} message limit exceeded`);
        return;
      }

      if (typeof op.timestamp !== 'number') {
        op.timestamp = Date.now();
      }

      // Throttle/batch operations to reduce message volume
      const batchedOps = await this.messageThrottleService.throttle(roomId, op);

      // Add all operations in batch
      for (const batchedOp of batchedOps) {
        this.mouseService.addOperation(roomId, batchedOp);
      }

      // Emit batch if multiple, single if just one
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
      const roomId = await this.roomService.getRoomIdForUser(client.id);
      if (!roomId) {
        client.emit('error', { message: 'Not assigned to a room' });
        return;
      }
      const userId = data?.userId || client.id;
      const canvasState = this.mouseService.removeUserOperations(userId);
      this.server
        .to(roomId)
        .emit('user_ops_removed', { userId, canvas_state: canvasState });
    } catch (error) {
      console.error('Error in handleResetOps:', error);
      client.emit('error', { message: 'Failed to reset operations' });
    }
  }
  @SubscribeMessage('move_pointer')
  handleMovePointer(
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
    const user = this.mouseService.getUser(client.id);
    const payload = {
      id: client.id,
      name: user?.name ?? '',
      color: user?.color ?? '#94A3B8',
      ...data,
    };
    // Broadcast to everyone except the sender (so others see this cursor)
    client.broadcast.emit('pointer_moved', payload);
  }
}
