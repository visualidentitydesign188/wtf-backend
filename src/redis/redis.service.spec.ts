import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService', () => {
  let service: RedisService;
  let mockRedisInstance: {
    on: jest.Mock;
    once: jest.Mock;
    quit: jest.Mock;
    duplicate: jest.Mock;
  };

  beforeEach(async () => {
    mockRedisInstance = {
      on: jest.fn(),
      once: jest.fn((ev, fn) => {
        if (ev === 'ready') setImmediate(fn);
        return mockRedisInstance;
      }),
      quit: jest.fn().mockResolvedValue(undefined),
      duplicate: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        once: jest.fn((ev, fn) => {
          if (ev === 'ready') setImmediate(fn);
          return {};
        }),
        quit: jest.fn().mockResolvedValue(undefined),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'REDIS_URL' ? 'redis://localhost:6379' : undefined)),
          },
        },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('without onModuleInit', () => {
    it('getPubClient and getSubClient are undefined until init', () => {
      expect(service.pubClient).toBeUndefined();
      expect(service.subClient).toBeUndefined();
    });
  });
});
