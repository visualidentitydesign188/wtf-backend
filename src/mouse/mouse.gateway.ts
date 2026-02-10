import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MouseService,type Operation } from './mouse.service';

@WebSocketGateway({
  cors: { origin: '*' },
  maxHttpBufferSize: 2e6, // 2MB to accommodate compressed fill results
})
export class MouseGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly mouseService: MouseService) {}

  handleConnection(client: Socket) {
    const currentPage = (client.handshake.query.current_page as string) || 'home';
    const user = this.mouseService.createUser(client.id, currentPage);
    console.log(`User connected: ${client.id} on page ${currentPage}`);
    
    const canvasState = this.mouseService.getCanvasState();
    client.emit('canvas_state', { operations: canvasState });
    this.server.emit('user_joined', user);
  }

  handleDisconnect(client: Socket) {
    this.mouseService.markUserDisconnected(client.id);
    this.mouseService.removeUser(client.id);
    console.log(`User disconnected: ${client.id}`);
    this.server.emit('user_left', { id: client.id });
  }

  @SubscribeMessage('draw_op')
  handleDrawOp(
    @ConnectedSocket() client: Socket,
    @MessageBody() op: Operation,
  ) {
    if (!op?.id || !op?.playerId || !op?.type) {
      console.warn('Invalid operation received:', op);
      return;
    }

    if (typeof op.timestamp !== 'number') {
      op.timestamp = Date.now();
    }

    // Log for debugging
    console.log('Received draw_op:', {
      id: op.id,
      type: op.type,
      playerId: op.playerId,
      timestamp: op.timestamp,
      hasFillResult: !!(op.data as any)?.fillResult,
      fillResultSize: (op.data as any)?.fillResult?.imageData?.length,
    });

    this.mouseService.addOperation(op);
    this.server.emit('draw_op', op);
  }

  @SubscribeMessage('reset_my_ops')
  handleResetOps(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string },
  ) {
    const userId = data?.userId || client.id;
    const canvasState = this.mouseService.removeUserOperations(userId);
    this.server.emit('user_ops_removed', { userId, canvas_state: canvasState });
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
    const payload = {
      id: client.id,
      ...data,
    };
    // Broadcast to everyone except the sender (so others see this cursor)
    client.broadcast.emit('pointer_moved', payload);
  }
}
