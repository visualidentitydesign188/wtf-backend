import { Test, TestingModule } from '@nestjs/testing';
import { RateLimitService } from './rate-limit.service';
import { RedisService } from '../redis/redis.service';

describe('RateLimitService', () => {
  let service: RateLimitService;
  let redis: { incr: jest.Mock; expire: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      incr: jest.fn(),
      expire: jest.fn(),
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitService,
        {
          provide: RedisService,
          useValue: { getPubClient: () => redis },
        },
      ],
    }).compile();

    service = module.get<RateLimitService>(RateLimitService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkDrawOpLimit', () => {
    it('should allow when under limits', async () => {
      redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      const result = await service.checkDrawOpLimit('socket-1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it('should deny when per-second limit exceeded', async () => {
      redis.incr.mockResolvedValueOnce(11);
      const result = await service.checkDrawOpLimit('socket-1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should deny when per-minute limit exceeded', async () => {
      redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(61);
      const result = await service.checkDrawOpLimit('socket-1');
      expect(result.allowed).toBe(false);
    });
  });

  describe('checkRoomMessageLimit', () => {
    it('should return true when under limit', async () => {
      redis.incr.mockResolvedValue(5);
      expect(await service.checkRoomMessageLimit('room_1')).toBe(true);
    });

    it('should return false when over limit', async () => {
      redis.incr.mockResolvedValue(51);
      expect(await service.checkRoomMessageLimit('room_1')).toBe(false);
    });
  });

  describe('resetSocketLimits', () => {
    it('should delete second and minute keys', async () => {
      redis.del.mockResolvedValue(1);
      await service.resetSocketLimits('socket-1');
      expect(redis.del).toHaveBeenCalledTimes(2);
    });
  });
});
