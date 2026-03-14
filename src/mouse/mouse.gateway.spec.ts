import { Test, TestingModule } from '@nestjs/testing';
import { MouseGateway } from './mouse.gateway';
import { MouseService } from './mouse.service';
import { RoomService } from './room.service';
import { RedisService } from '../redis/redis.service';
import { RateLimitService } from './rate-limit.service';
import { MessageThrottleService } from './message-throttle.service';
import type { Socket } from 'socket.io';

function createMockRedisClient() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string, ..._args: any[]) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => { store.delete(key); return Promise.resolve(1); }),
    smembers: jest.fn((key: string) => {
      const s = sets.get(key);
      return Promise.resolve(s ? Array.from(s) : []);
    }),
    sadd: jest.fn(),
    srem: jest.fn(),
    scard: jest.fn(() => Promise.resolve(0)),
    incr: jest.fn(() => Promise.resolve(1)),
    keys: jest.fn(() => Promise.resolve([])),
    expire: jest.fn(),
    on: jest.fn(),
    pipeline: jest.fn(() => {
      const cmds: any[] = [];
      const pipe = {
        get: jest.fn((key: string) => { cmds.push(() => Promise.resolve([null, store.get(key) ?? null])); return pipe; }),
        expire: jest.fn(() => { cmds.push(() => Promise.resolve([null, 1])); return pipe; }),
        exec: jest.fn(() => Promise.all(cmds.map((fn) => fn()))),
      };
      return pipe;
    }),
    store,
    sets,
  };
}

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
      leave: jest.fn(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      broadcast: { emit: jest.fn() } as any,
      rooms: new Set(['socket-1']),
      handshake: {
        query: { current_page: 'page1' },
      } as unknown as Socket['handshake'],
    };

    const mockRedis = createMockRedisClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MouseGateway,
        MouseService,
        RoomService,
        {
          provide: RedisService,
          useValue: {
            getPubClient: jest.fn(() => mockRedis),
            getSubClient: jest.fn(() => mockRedis),
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
      await mouseService.createUser('socket-1', 'p', 'room_1');
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
        allowed: false, remaining: 0, resetAt: 123,
      });
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1', playerId: 'p1', type: 'pencil', timestamp: 1, data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('rate_limit_exceeded', expect.any(Object));
    });

    it('should reassign to new room when room expired and process draw op', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue(null);
      jest.spyOn(roomService, 'getOrCreateRoomForUser').mockResolvedValue('room_new');
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1', playerId: 'p1', type: 'pencil', timestamp: 1, data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('room_assigned', { roomId: 'room_new' });
      expect(mockServer.to).toHaveBeenCalledWith('room_new');
    });

    it('should add operation and emit draw_op for single op', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue('room_1');
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1', playerId: 'p1', type: 'pencil', timestamp: 1, data: {},
      });
      const state = await mouseService.getCanvasState('room_1');
      expect(state).toHaveLength(1);
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });

    it('should emit error for invalid op', async () => {
      await gateway.handleDrawOp(mockClient as Socket, {
        id: '', playerId: 'socket-1', type: 'pencil', timestamp: 1, data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.any(String) }));
    });

    it('should reject invalid operation type', async () => {
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1', playerId: 'socket-1', type: 'laser' as any, timestamp: 1, data: {},
      });
      expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.stringContaining('type') }));
    });

    it('should reject oversized path array', async () => {
      const bigPath = Array.from({ length: 5001 }, (_, i) => ({ x: i, y: i }));
      await gateway.handleDrawOp(mockClient as Socket, {
        id: 'op1', playerId: 'socket-1', type: 'pencil', timestamp: 1, data: { path: bigPath },
      });
      expect(mockClient.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: expect.stringContaining('path') }));
    });
  });

  describe('handleResetOps', () => {
    it('should reassign to new room when room expired', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue(null);
      jest.spyOn(roomService, 'getOrCreateRoomForUser').mockResolvedValue('room_new');
      await gateway.handleResetOps(mockClient as Socket, {});
      expect(mockClient.emit).toHaveBeenCalledWith('room_assigned', { roomId: 'room_new' });
      expect(mockServer.to).toHaveBeenCalledWith('room_new');
    });

    it('should remove user ops and emit user_ops_removed', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue('room_1');
      await mouseService.createUser('socket-1', 'p', 'room_1');
      await gateway.handleResetOps(mockClient as Socket, {});
      expect(mockServer.to).toHaveBeenCalledWith('room_1');
    });
  });

  describe('handleMovePointer', () => {
    it('should emit pointer_moved only to the room, not broadcast', async () => {
      jest.spyOn(roomService, 'getRoomIdForUser').mockResolvedValue('room_1');
      await mouseService.createUser('socket-1', 'p', 'room_1');
      await gateway.handleMovePointer(mockClient as Socket, {
        x: 10, y: 20, current_page: 'home',
      });
      expect(mockClient.to).toHaveBeenCalledWith('room_1');
    });
  });
});
