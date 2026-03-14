import { Test, TestingModule } from '@nestjs/testing';
import { RoomService } from './room.service';
import { RedisService } from '../redis/redis.service';

function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  let counter = 0;

  const redis: Record<string, jest.Mock> = {
    scan: jest.fn((_cursor: string, ..._args: any[]) => {
      const allKeys = [
        ...store.keys(),
        ...sets.keys(),
      ].filter((k, i, arr) => arr.indexOf(k) === i);
      return Promise.resolve(['0', allKeys]);
    }),
    scard: jest.fn((key: string) => {
      const s = sets.get(key);
      return Promise.resolve(s ? s.size : 0);
    }),
    sadd: jest.fn((key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key)!.add(m);
      return Promise.resolve(members.length);
    }),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    srem: jest.fn((key: string, member: string) => {
      const s = sets.get(key);
      if (s) { s.delete(member); return Promise.resolve(1); }
      return Promise.resolve(0);
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      sets.delete(key);
      return Promise.resolve(1);
    }),
    smembers: jest.fn((key: string) => {
      const s = sets.get(key);
      return Promise.resolve(s ? Array.from(s) : []);
    }),
    incr: jest.fn(() => Promise.resolve(++counter)),
    pipeline: jest.fn(() => {
      const cmds: Array<() => Promise<[null, unknown]>> = [];
      const pipe: Record<string, jest.Mock> = {
        scard: jest.fn((key: string) => {
          cmds.push(() => {
            const s = sets.get(key);
            return Promise.resolve([null, s ? s.size : 0]);
          });
          return pipe;
        }),
        sadd: jest.fn((key: string, ...members: string[]) => {
          cmds.push(() => {
            if (!sets.has(key)) sets.set(key, new Set());
            for (const m of members) sets.get(key)!.add(m);
            return Promise.resolve([null, members.length]);
          });
          return pipe;
        }),
        set: jest.fn((key: string, value: string) => {
          cmds.push(() => {
            store.set(key, value);
            return Promise.resolve([null, 'OK']);
          });
          return pipe;
        }),
        expire: jest.fn(() => {
          cmds.push(() => Promise.resolve([null, 1]));
          return pipe;
        }),
        srem: jest.fn((key: string, member: string) => {
          cmds.push(() => {
            const s = sets.get(key);
            if (s) { s.delete(member); return Promise.resolve([null, 1]); }
            return Promise.resolve([null, 0]);
          });
          return pipe;
        }),
        del: jest.fn((key: string) => {
          cmds.push(() => {
            store.delete(key);
            sets.delete(key);
            return Promise.resolve([null, 1]);
          });
          return pipe;
        }),
        exec: jest.fn(() => Promise.all(cmds.map((fn) => fn()))),
      };
      return pipe;
    }),
  };

  return { redis, store, sets, resetCounter: () => { counter = 0; } };
}

describe('RoomService', () => {
  let service: RoomService;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRedis = createMockRedis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomService,
        {
          provide: RedisService,
          useValue: { getPubClient: () => mockRedis.redis },
        },
      ],
    }).compile();

    service = module.get<RoomService>(RoomService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOrCreateRoomForUser', () => {
    it('should add user to existing room with space', async () => {
      mockRedis.sets.set('room:room_1', new Set(['s0', 's1']));
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
      expect(mockRedis.sets.get('room:room_1')!.has('socket-1')).toBe(true);
    });

    it('should skip room:counter in scan results', async () => {
      mockRedis.store.set('room:counter', '1');
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
    });

    it('should create new room when all rooms are full', async () => {
      mockRedis.sets.set('room:room_1', new Set(['a', 'b', 'c', 'd', 'e']));
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
      expect(mockRedis.sets.has(`room:${roomId}`)).toBe(true);
    });

    it('should create new room when no rooms exist', async () => {
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
      expect(mockRedis.sets.get('room:room_1')!.has('socket-1')).toBe(true);
    });

    it('should set socket-to-room mapping', async () => {
      await service.getOrCreateRoomForUser('socket-1');
      expect(mockRedis.store.get('socket:socket-1')).toBeDefined();
    });
  });

  describe('getRoomIdForUser', () => {
    it('should return room id', async () => {
      mockRedis.store.set('socket:socket-1', 'room_1');
      expect(await service.getRoomIdForUser('socket-1')).toBe('room_1');
    });

    it('should return null for unknown socket', async () => {
      expect(await service.getRoomIdForUser('unknown')).toBeNull();
    });
  });

  describe('removeUserFromRoom', () => {
    it('should return null when user not in a room', async () => {
      expect(await service.removeUserFromRoom('socket-1')).toBeNull();
    });

    it('should remove user and delete room when empty', async () => {
      mockRedis.store.set('socket:socket-1', 'room_1');
      mockRedis.sets.set('room:room_1', new Set(['socket-1']));
      const roomId = await service.removeUserFromRoom('socket-1');
      expect(roomId).toBe('room_1');
      expect(mockRedis.sets.has('room:room_1')).toBe(false);
      expect(mockRedis.store.has('socket:socket-1')).toBe(false);
    });

    it('should not delete room when still has members', async () => {
      mockRedis.store.set('socket:socket-1', 'room_1');
      mockRedis.sets.set('room:room_1', new Set(['socket-1', 'socket-2']));
      await service.removeUserFromRoom('socket-1');
      expect(mockRedis.sets.has('room:room_1')).toBe(true);
      expect(mockRedis.sets.get('room:room_1')!.has('socket-1')).toBe(false);
      expect(mockRedis.sets.get('room:room_1')!.has('socket-2')).toBe(true);
    });
  });

  describe('getRoomUserIds', () => {
    it('should return member ids', async () => {
      mockRedis.sets.set('room:room_1', new Set(['s1', 's2']));
      const ids = await service.getRoomUserIds('room_1');
      expect(ids.sort()).toEqual(['s1', 's2']);
    });
  });

  describe('getRoomSize', () => {
    it('should return count', async () => {
      mockRedis.sets.set('room:room_1', new Set(['a', 'b', 'c']));
      expect(await service.getRoomSize('room_1')).toBe(3);
    });

    it('should return 0 for non-existent room', async () => {
      expect(await service.getRoomSize('room_x')).toBe(0);
    });
  });
});
