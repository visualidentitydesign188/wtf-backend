import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MouseService } from './mouse.service';
import type { Operation } from './mouse.service';
@WebSocketGateway({
  cors: { origin: '*' },
})
export class MouseGateway
  implements
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnModuleInit,
  OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  CANVAS_SEED = 0x8f3a_2b1c;

  constructor(private readonly mouseService: MouseService) { }

  onModuleInit() {
    const intervalMs = this.mouseService.getCleanupIntervalMs();
    this.cleanupTimer = setInterval(() => {
      const { removedUserIds, canvasState } =
        this.mouseService.cleanupTimeoutUsers();
      for (const userId of removedUserIds) {
        this.server.emit('user_ops_removed', {
          userId,
          canvas_state: canvasState,
        });
      }
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  handleConnection(client: Socket) {
    const user = this.mouseService.createUser(client.id, '/');
    const initPayload = {
      ...user,
      seed: this.CANVAS_SEED,
      canvasSeed: this.CANVAS_SEED,
    };
    client.emit('init', initPayload);
    client.emit('current_users', this.mouseService.getAllUsers());
    client.emit('canvas_state', {
      operations: this.mouseService.getCanvasState(),
    });
    client.broadcast.emit('new_user_joined', user);
  }

  handleDisconnect(client: Socket) {
    this.mouseService.markUserDisconnected(client.id);
    this.mouseService.removeUser(client.id);
    this.server.emit('user_left', client.id);
  }

  @SubscribeMessage('move_pointer')
  handlePointerMove(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      pageX: number;
      pageY: number;
      current_page: string;
    },
  ) {
    const updated = this.mouseService.updateUserPosition(
      client.id,
      data.x,
      data.y,
      data.scrollX,
      data.scrollY,
      data.pageX,
      data.pageY,
      data.current_page,
    );
    if (updated) {
      client.broadcast.emit('pointer_moved', updated);
    }
  }

  @SubscribeMessage('scroll_update')
  handleScrollUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { scrollX: number; scrollY: number },
  ) {
    const updated = this.mouseService.updateUserScroll(
      client.id,
      data.scrollX,
      data.scrollY,
    );
    if (updated) {
      client.broadcast.emit('pointer_moved', updated);
    }
  }

  @SubscribeMessage('draw_op')
  handleDrawOp(
    @ConnectedSocket() client: Socket,
    @MessageBody() op: Operation,
  ) {
    console.log('Received draw_op:', {
      id: op?.id,
      type: op?.type,
      playerId: op?.playerId,
      hasFillResult: !!(op?.data as any)?.fillResult,
      dataKeys: op?.data ? Object.keys(op.data) : []
    });

    const { id, playerId, type, timestamp, data } = op;
    if (!id || !playerId || !type || typeof timestamp !== 'number' || !data) {
      console.warn('Invalid operation received:', op);
      return;
    }
    
    // CRITICAL: Preserve ALL data fields including fillResult
    const safeOp: Operation = { 
      id, 
      playerId, 
      type, 
      timestamp, 
      data: {
        ...data, // This MUST preserve fillResult, fillPoint, targetColor, fillColor, etc.
      }
    };
    
    console.log('Broadcasting operation:', {
      id: safeOp.id,
      type: safeOp.type,
      hasFillResult: !!(safeOp.data as any)?.fillResult
    });
    
    this.mouseService.addOperation(safeOp);
    this.server.emit('draw_op', safeOp); // Broadcast to ALL clients
  }

  @SubscribeMessage('reset_my_ops')
  handleResetMyOps(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string },
  ) {
    // Use the userId from the payload, or fallback to client.id
    const userId = data?.userId || client.id;

    // Remove this user's operations from the canvas state
    // You'll need to add this method to MouseService if it doesn't exist
    const canvasState = this.mouseService.removeUserOperations(userId);

    // Broadcast to all clients (including the one who reset)
    this.server.emit('user_ops_removed', {
      userId,
      canvas_state: canvasState,
    });
  }
}
