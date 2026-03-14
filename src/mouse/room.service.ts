import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export const MAX_ROOM_SIZE = 5;

/**
 * RoomService with Redis backend for horizontal scaling.
 * Room state is shared across all server instances via Redis.
 */
@Injectable()
export class RoomService {
  private readonly ROOM_PREFIX = 'room:';
  private readonly SOCKET_PREFIX = 'socket:';
  private readonly ROOM_COUNTER_KEY = 'room:counter';
  private static readonly ROOM_TTL = 3600;
  private static readonly SCAN_BATCH = 100;

  constructor(private readonly redisService: RedisService) {}

  /**
   * Assigns a socket to a room: either the first room with space (< MAX_ROOM_SIZE)
   * or a newly created room. Uses SCAN (non-blocking) instead of KEYS, and
   * pipelines SCARD calls to check room sizes in a single round-trip.
   */
  async getOrCreateRoomForUser(socketId: string): Promise<string> {
    const redis = this.redisService.getPubClient();

    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${this.ROOM_PREFIX}*`,
        'COUNT',
        RoomService.SCAN_BATCH,
      );
      cursor = nextCursor;

      const roomKeys = keys.filter((k) => k !== this.ROOM_COUNTER_KEY);
      if (roomKeys.length === 0) continue;

      const sizePipeline = redis.pipeline();
      for (const key of roomKeys) {
        sizePipeline.scard(key);
      }
      const sizeResults = await sizePipeline.exec();

      for (let i = 0; i < roomKeys.length; i++) {
        const [err, size] = sizeResults![i];
        if (err || (size as number) >= MAX_ROOM_SIZE) continue;

        const roomKey = roomKeys[i];
        const roomId = roomKey.replace(this.ROOM_PREFIX, '');
        await this.joinRoom(redis, roomKey, roomId, socketId);
        return roomId;
      }
    } while (cursor !== '0');

    const roomId = await this.generateRoomId();
    const roomKey = `${this.ROOM_PREFIX}${roomId}`;
    await this.joinRoom(redis, roomKey, roomId, socketId);
    return roomId;
  }

  async getRoomIdForUser(socketId: string): Promise<string | null> {
    const redis = this.redisService.getPubClient();
    return redis.get(`${this.SOCKET_PREFIX}${socketId}`);
  }

  /**
   * Removes user from their room. Returns the roomId they were in.
   * Deletes the room key if it becomes empty.
   */
  async removeUserFromRoom(socketId: string): Promise<string | null> {
    const redis = this.redisService.getPubClient();
    const roomId = await redis.get(`${this.SOCKET_PREFIX}${socketId}`);
    if (!roomId) return null;

    const roomKey = `${this.ROOM_PREFIX}${roomId}`;

    const removePipeline = redis.pipeline();
    removePipeline.srem(roomKey, socketId);
    removePipeline.del(`${this.SOCKET_PREFIX}${socketId}`);
    await removePipeline.exec();

    const size = await redis.scard(roomKey);
    if (size === 0) {
      await redis.del(roomKey);
    }

    return roomId;
  }

  async getRoomUserIds(roomId: string): Promise<string[]> {
    const redis = this.redisService.getPubClient();
    return redis.smembers(`${this.ROOM_PREFIX}${roomId}`);
  }

  async getRoomSize(roomId: string): Promise<number> {
    const redis = this.redisService.getPubClient();
    return redis.scard(`${this.ROOM_PREFIX}${roomId}`);
  }

  private async generateRoomId(): Promise<string> {
    const redis = this.redisService.getPubClient();
    const counter = await redis.incr(this.ROOM_COUNTER_KEY);
    return `room_${counter}`;
  }

  private async joinRoom(
    redis: ReturnType<RedisService['getPubClient']>,
    roomKey: string,
    roomId: string,
    socketId: string,
  ): Promise<void> {
    const pipeline = redis.pipeline();
    pipeline.sadd(roomKey, socketId);
    pipeline.set(
      `${this.SOCKET_PREFIX}${socketId}`,
      roomId,
      'EX',
      RoomService.ROOM_TTL,
    );
    pipeline.expire(roomKey, RoomService.ROOM_TTL);
    await pipeline.exec();
  }
}
