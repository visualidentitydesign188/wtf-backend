import { Test, TestingModule } from '@nestjs/testing';
import {
  MouseService,
  type Operation,
  type UserPointer,
} from './mouse.service';
import { RedisService } from '../redis/redis.service';

function createMockRedisService() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const mockRedis = {
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string, ..._args: any[]) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    smembers: jest.fn((key: string) => {
      const s = sets.get(key);
      return Promise.resolve(s ? Array.from(s) : []);
    }),
    sadd: jest.fn((key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key)!.add(m);
      return Promise.resolve(members.length);
    }),
    pipeline: jest.fn(() => {
      const cmds: Array<() => Promise<[null, string | null]>> = [];
      const pipe = {
        get: jest.fn((key: string) => {
          cmds.push(() =>
            Promise.resolve([null, store.get(key) ?? null] as [
              null,
              string | null,
            ]),
          );
          return pipe;
        }),
        exec: jest.fn(() => Promise.all(cmds.map((fn) => fn()))),
      };
      return pipe;
    }),
  };

  return {
    redisService: {
      getPubClient: jest.fn(() => mockRedis),
      getSubClient: jest.fn(() => mockRedis),
    } as unknown as RedisService,
    mockRedis,
    store,
    sets,
  };
}

describe('MouseService', () => {
  let service: MouseService;

  beforeEach(async () => {
    const { redisService } = createMockRedisService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MouseService,
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<MouseService>(MouseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createUser', () => {
    it('should create user with random name and default fields', async () => {
      const user = await service.createUser('socket-1', 'home', 'room_1');
      expect(user).toMatchObject({
        id: 'socket-1',
        current_page: 'home',
        roomId: 'room_1',
        x: 0,
        y: 0,
      });
      expect(typeof user.name).toBe('string');
      expect(user.name.length).toBeGreaterThan(0);
      expect(user.color).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('should be retrievable via getUser locally', async () => {
      await service.createUser('s1', 'p', 'r1');
      expect(service.getUser('s1')).toBeDefined();
    });
  });

  describe('updateUserPosition', () => {
    it('should update position and return user', async () => {
      await service.createUser('u1', 'page', 'room_1');
      const updated = service.updateUserPosition(
        'u1', 10, 20, 5, 5, 15, 25, 'other',
      );
      expect(updated).toMatchObject({ id: 'u1', x: 10, y: 20 });
    });

    it('should return null for unknown user', () => {
      expect(
        service.updateUserPosition('unknown', 0, 0, 0, 0, 0, 0, ''),
      ).toBeNull();
    });
  });

  describe('updateUserScroll', () => {
    it('should update scroll and derived page position', async () => {
      await service.createUser('u1', 'p', 'r1');
      service.updateUserPosition('u1', 100, 50, 0, 0, 100, 50, 'p');
      const updated = service.updateUserScroll('u1', 10, 20);
      expect(updated).toMatchObject({
        scrollX: 10,
        scrollY: 20,
        pageX: 110,
        pageY: 70,
      });
    });

    it('should return null for unknown user', () => {
      expect(service.updateUserScroll('unknown', 0, 0)).toBeNull();
    });
  });

  describe('removeUser', () => {
    it('should remove user and return true', async () => {
      await service.createUser('u1', 'p', 'r1');
      expect(await service.removeUser('u1')).toBe(true);
      expect(service.getUser('u1')).toBeUndefined();
    });

    it('should return false when user does not exist', async () => {
      expect(await service.removeUser('none')).toBe(false);
    });
  });

  describe('getUsersInRoom', () => {
    it('should return users from Redis for a room', async () => {
      const { redisService, sets } = createMockRedisService();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          MouseService,
          { provide: RedisService, useValue: redisService },
        ],
      }).compile();
      const svc = module.get<MouseService>(MouseService);

      sets.set('room:room_1', new Set(['s1', 's2']));
      await svc.createUser('s1', 'p', 'room_1');
      await svc.createUser('s2', 'p', 'room_1');
      const users = await svc.getUsersInRoom('room_1');
      expect(users).toHaveLength(2);
    });
  });

  describe('getCanvasState', () => {
    it('should return empty array for unknown room', async () => {
      expect(await service.getCanvasState('room_x')).toEqual([]);
    });

    it('should return operations sorted by timestamp then id', async () => {
      const op1: Operation = { id: 'a', playerId: 'p1', type: 'pencil', timestamp: 100, data: {} };
      const op2: Operation = { id: 'b', playerId: 'p1', type: 'pencil', timestamp: 50, data: {} };
      await service.addOperations('room_1', [op1, op2]);
      const state = await service.getCanvasState('room_1');
      expect(state.map((o) => o.id)).toEqual(['b', 'a']);
    });
  });

  describe('addOperations', () => {
    it('should add operations and set timestamp if missing', async () => {
      const op: Operation = {
        id: 'op1', playerId: 'p1', type: 'pencil', timestamp: 0, data: {},
      };
      (op as { timestamp?: number }).timestamp = undefined as unknown as number;
      await service.addOperations('room_1', [op]);
      expect(op.timestamp).toBeGreaterThan(0);
      expect(await service.getCanvasState('room_1')).toHaveLength(1);
    });

    it('should update existing operation by id and preserve fillResult', async () => {
      const fillOp: Operation = {
        id: 'f1', playerId: 'p1', type: 'fillColor', timestamp: 1,
        data: { fillResult: { cells: 10 } },
      };
      await service.addOperations('room_1', [fillOp]);
      const updateOp: Operation = {
        id: 'f1', playerId: 'p1', type: 'fillColor', timestamp: 2, data: {},
      };
      await service.addOperations('room_1', [updateOp]);
      const state = await service.getCanvasState('room_1');
      expect(state).toHaveLength(1);
      expect(state[0].data.fillResult).toEqual({ cells: 10 });
    });

    it('should insert operations in timestamp order', async () => {
      await service.addOperations('room_1', [
        { id: 'c', playerId: 'p1', type: 'pencil', timestamp: 30, data: {} },
        { id: 'a', playerId: 'p1', type: 'pencil', timestamp: 10, data: {} },
        { id: 'b', playerId: 'p1', type: 'pencil', timestamp: 20, data: {} },
      ]);
      const state = await service.getCanvasState('room_1');
      expect(state.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('removeOperationsByPlayerId', () => {
    it('should remove ops by player and return new canvas state', async () => {
      await service.addOperations('room_1', [
        { id: '1', playerId: 'p1', type: 'pencil', timestamp: 1, data: {} },
        { id: '2', playerId: 'p2', type: 'pencil', timestamp: 2, data: {} },
      ]);
      const state = await service.removeOperationsByPlayerId('room_1', 'p1');
      expect(state).toHaveLength(1);
      expect(state[0].playerId).toBe('p2');
    });
  });

  describe('removeUserOperations', () => {
    it('should return empty array for unknown user', async () => {
      expect(await service.removeUserOperations('unknown')).toEqual([]);
    });

    it('should remove ops for user and return new state', async () => {
      await service.createUser('u1', 'p', 'room_1');
      await service.addOperations('room_1', [
        { id: '1', playerId: 'u1', type: 'pencil', timestamp: 1, data: {} },
      ]);
      const state = await service.removeUserOperations('u1');
      expect(state).toHaveLength(0);
    });
  });
});
