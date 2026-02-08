import { Test, TestingModule } from '@nestjs/testing';
import { MouseGateway } from './mouse.gateway';
import { MouseService } from './mouse.service';
import { RoomService } from './room.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';
import { MessageThrottleService } from './message-throttle.service';
import type { Socket } from 'socket.io';

describe('MouseGateway', () => {
  let gateway: MouseGateway;
  let roomService: RoomService;
  let mouseService: MouseService;
  let rateLimitService: RateLimitService;
  let messageThrottleService: MessageThrottleService;
  let redisService: RedisService;
  let mockServer: { to: jest.Mock; adapter: jest.Mock };
  let mockClient: Partial<Socket>;

  beforeEach(async () => {
    mockServer = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      adapter: jest.fn(),
    };

    mockClient = {
      id: 'socket-1',
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
      handshake: { query: { current_page: 'page1' } } as unknown as Socket['handshake'],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MouseGateway,
        MouseService,
        RoomService,
        {
          provide: RedisService,
          useValue: {
            getPubClient: jest.fn(() => ({ on: jest.fn() })),
            getSubClient: jest.fn(() => ({ on: jest.fn() })),
          },
        },
        {
          provide: RateLimitService,
          useValue: {
            checkDrawOpLimit: jest.fn().mockResolvedValue({ allowed: true }),
            checkRoomMessageLimit: jest.fn().mockResolvedValue(true),
            resetSocketLimits: jest.fn(),
          },
        },
        {
          provide: MessageThrottleService,
          useValue: {
            throttle: jest.fn().mockImplementation((_, op) => Promise.resolve([op])),
            flush: jest.fn(),
          },
        },
      ],
    }).compile();

    gateway = module.get<MouseGateway>(MouseGateway);
    roomService = module.get<RoomService>(RoomService);
    mouseService = module.get<MouseService>(MouseService);
    rateLimitService = module.get<RateLimitService>(RateLimitService);
    messageThrottleService = module.get<MessageThrottleService>(MessageThrottleService);
    redisService = module.get<RedisService>(RedisService);

    (gateway as unknown as { server: typeof mockServer }).server = mockServer;
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('onApplicationBootstrap', () => {
    it('should set adapter when Redis clients exist', () => {
      gateway.onApplicationBootstrap();
      expect(mockServer.adapter).toHaveBeenCalled();
    });

    it('should not set adapter when getSubClient returns undefined', () => {
      (redisService.getSubClient as jest.Mock).mockReturnValueOnce(undefined);
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      gateway.onApplicationBootstrap();
      expect(warn).toHaveBeenCalledWith(
        'Socket.IO Redis adapter skipped: Redis clients not available',
      );
      warn.mockRestore();
    });
  });

  describe('handleConnection', () => {
    it('should join room, create user, emit canvas_state and room_assigned', async () => {
      jest.spyOn(roomService, 'getOrCreateRoomForUser').mockResolvedValue('room_1');
      jest.spyOn(roomService, 'getRoomSize').mockResolvedValue(1);
      await gateway.handleConnection(mockClient as Socket);
      expect(mockClient.join).toHaveBeenCalledWith('room_1');
      expect(mockClient.emit).toHaveBeenCalledWith('canvas_state', expect.any(Object));
      expect(mockClient.emit).toHaveBeenCalledWith('room_assigned', { roomId: 'room_1' });
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });

    it('should disconnect client on error', async () => {
      jest.spyOn(roomService, 'getOrCreateRoomForUser').mockRejectedValue(new Error('redis down'));
      await gateway.handleConnection(mockClient as Socket);
      expect(mockClient.disconnect).toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should flush throttle, remove user and emit user_left when roomId exists', async () => {
      jest.spyOn(roomService, 'removeUserFromRoom').mockResolvedValue('room_1');
      mouseService.createUser('socket-1', 'p', 'room_1');
      await gateway.handleDisconnect(mockClient as Socket);
      expect(messageThrottleService.flush).toHaveBeenCalledWith('room_1');
      expect(rateLimitService.resetSocketLimits).toHaveBeenCalledWith('socket-1');
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });

    it('should not emit user_left when roomId is null', async () => {
      jest.spyOn(roomService, 'removeUserFromRoom').mockResolvedValue(null);
      await gateway.handleDisconnect(mockClient as Socket);
      expect(mockServer.to).not.toHaveBeenCalled();
    });
  });

  describe('handleDrawOp', () => {
    it('should emit rate_limit_exceeded when not allowed', async () => {
      jest.spyOn(rateLimitService, 'checkDrawOpLimit').mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: 123,
      });
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('rate_limit_exceeded', expect.any(Object));
    });

    it('should emit error when not assigned to room', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue(null);
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('error', { message: 'Not assigned to a room' });
    });

    it('should add operation and emit draw_op for single op', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue('room_1');
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      expect(mouseService.getCanvasState('room_1')).toHaveLength(1);
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });

    it('should return early for invalid op', async () => {
      await gateway.handleDrawOp(mockClient as Socket, {
        id: '',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      expect(mockClient.emit).not.toHaveBeenCalledWith('draw_op', expect.anything());
    });
  });

  describe('handleResetOps', () => {
    it('should emit error when not in room', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue(null);
      await gateway.handleResetOps(mockClient as Socket, {});
      expect(mockClient.emit).toHaveBeenCalledWith('error', { message: 'Not assigned to a room' });
    });

    it('should remove user ops and emit user_ops_removed', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue('room_1');
      mouseService.createUser('socket-1', 'p', 'room_1');
      await gateway.handleResetOps(mockClient as Socket, {});
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });
  });
});
