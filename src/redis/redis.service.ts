import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { Redis as RedisType } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  public pubClient: RedisType;
  public subClient: RedisType;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';

    const redisOptions = redisUrl.startsWith('redis://')
      ? { host: 'localhost', port: 6379 }
      : { url: redisUrl };

    this.pubClient = new Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.subClient = new Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    // Error handling
    this.pubClient.on('error', (err) => {
      console.error('Redis Pub Client Error:', err);
    });
    this.subClient.on('error', (err) => {
      console.error('Redis Sub Client Error:', err);
    });

    this.pubClient.on('connect', () => {
      console.log('Redis Pub Client connected');
    });
    this.subClient.on('connect', () => {
      console.log('Redis Sub Client connected');
    });

    // Wait for ready
    await Promise.all([
      new Promise((resolve) => this.pubClient.once('ready', resolve)),
      new Promise((resolve) => this.subClient.once('ready', resolve)),
    ]);
    console.log('Redis clients ready');
  }

  async onModuleDestroy() {
    await Promise.all([this.pubClient.quit(), this.subClient.quit()]);
  }

  getPubClient(): RedisType {
    return this.pubClient;
  }

  getSubClient(): RedisType {
    return this.subClient;
  }
}
