import { Test, TestingModule } from '@nestjs/testing';
import { RoomService } from './room.service';
import { RedisService } from '../redis/redis.service';

describe('RoomService', () => {
  let service: RoomService;
  let redis: {
    keys: jest.Mock;
    scard: jest.Mock;
    sadd: jest.Mock;
    set: jest.Mock;
    expire: jest.Mock;
    get: jest.Mock;
    srem: jest.Mock;
    del: jest.Mock;
    smembers: jest.Mock;
    incr: jest.Mock;
  };

  beforeEach(async () => {
    redis = {
      keys: jest.fn(),
      scard: jest.fn(),
      sadd: jest.fn(),
      set: jest.fn(),
      expire: jest.fn(),
      get: jest.fn(),
      srem: jest.fn(),
      del: jest.fn(),
      smembers: jest.fn(),
      incr: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomService,
        {
          provide: RedisService,
          useValue: { getPubClient: () => redis },
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
      redis.keys.mockResolvedValue(['room:room_1']);
      redis.scard.mockResolvedValue(2);
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
      expect(redis.sadd).toHaveBeenCalledWith('room:room_1', 'socket-1');
      expect(redis.set).toHaveBeenCalledWith('socket:socket-1', 'room_1');
      expect(redis.incr).not.toHaveBeenCalled();
    });

    it('should skip ROOM_COUNTER_KEY in keys', async () => {
      redis.keys.mockResolvedValue(['room:counter']);
      redis.incr.mockResolvedValue(1);
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_1');
      expect(redis.sadd).toHaveBeenCalledWith('room:room_1', 'socket-1');
    });

    it('should create new room when all full', async () => {
      redis.keys.mockResolvedValue(['room:room_1']);
      redis.scard.mockResolvedValue(5);
      redis.incr.mockResolvedValue(2);
      const roomId = await service.getOrCreateRoomForUser('socket-1');
      expect(roomId).toBe('room_2');
      expect(redis.sadd).toHaveBeenCalledWith('room:room_2', 'socket-1');
      expect(redis.expire).toHaveBeenCalled();
    });
  });

  describe('getRoomIdForUser', () => {
    it('should return room id', async () => {
      redis.get.mockResolvedValue('room_1');
      expect(await service.getRoomIdForUser('socket-1')).toBe('room_1');
      expect(redis.get).toHaveBeenCalledWith('socket:socket-1');
    });
  });

  describe('removeUserFromRoom', () => {
    it('should return null when user not in a room', async () => {
      redis.get.mockResolvedValue(null);
      expect(await service.removeUserFromRoom('socket-1')).toBeNull();
    });

    it('should remove user and delete room when empty', async () => {
      redis.get.mockResolvedValue('room_1');
      redis.srem.mockResolvedValue(1);
      redis.scard.mockResolvedValue(0);
      const roomId = await service.removeUserFromRoom('socket-1');
      expect(roomId).toBe('room_1');
      expect(redis.del).toHaveBeenCalledWith('room:room_1');
    });

    it('should not delete room when still has members', async () => {
      redis.get.mockResolvedValue('room_1');
      redis.scard.mockResolvedValue(1);
      await service.removeUserFromRoom('socket-1');
      expect(redis.del).toHaveBeenCalledWith('socket:socket-1');
      expect(redis.del).not.toHaveBeenCalledWith('room:room_1');
    });
  });

  describe('getRoomUserIds', () => {
    it('should return member ids', async () => {
      redis.smembers.mockResolvedValue(['s1', 's2']);
      expect(await service.getRoomUserIds('room_1')).toEqual(['s1', 's2']);
      expect(redis.smembers).toHaveBeenCalledWith('room:room_1');
    });
  });

  describe('getRoomSize', () => {
    it('should return count', async () => {
      redis.scard.mockResolvedValue(3);
      expect(await service.getRoomSize('room_1')).toBe(3);
    });
  });
});
