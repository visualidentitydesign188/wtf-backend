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

  constructor(private readonly redisService: RedisService) {}

  /**
   * Assigns a socket to a room: either the first room with space (< MAX_ROOM_SIZE)
   * or a newly created room. Returns the room ID and joins the socket to it.
   * Uses Redis for distributed room management.
   */
  async getOrCreateRoomForUser(socketId: string): Promise<string> {
    const redis = this.redisService.getPubClient();

    // Find first room with space
    const roomKeys = await redis.keys(`${this.ROOM_PREFIX}*`);
    for (const roomKey of roomKeys) {
      if (roomKey === this.ROOM_COUNTER_KEY) continue;

      const size = await redis.scard(roomKey);
      if (size < MAX_ROOM_SIZE) {
        const roomId = roomKey.replace(this.ROOM_PREFIX, '');
        await redis.sadd(roomKey, socketId);
        await redis.set(`${this.SOCKET_PREFIX}${socketId}`, roomId);
        await redis.expire(`${this.SOCKET_PREFIX}${socketId}`, 3600); // 1 hour TTL
        return roomId;
      }
    }

    // All rooms full — create new room
    const roomId = await this.generateRoomId();
    const roomKey = `${this.ROOM_PREFIX}${roomId}`;
    await redis.sadd(roomKey, socketId);
    await redis.set(`${this.SOCKET_PREFIX}${socketId}`, roomId);
    await redis.expire(`${this.SOCKET_PREFIX}${socketId}`, 3600);
    await redis.expire(roomKey, 3600); // Auto-cleanup empty rooms

    return roomId;
  }

  async getRoomIdForUser(socketId: string): Promise<string | null> {
    const redis = this.redisService.getPubClient();
    return redis.get(`${this.SOCKET_PREFIX}${socketId}`);
  }

  /**
   * Removes user from their room. Returns the roomId they were in (for broadcasting).
   * Removes the room entry if it becomes empty.
   */
  async removeUserFromRoom(socketId: string): Promise<string | null> {
    const redis = this.redisService.getPubClient();
    const roomId = await redis.get(`${this.SOCKET_PREFIX}${socketId}`);

    if (!roomId) return null;

    const roomKey = `${this.ROOM_PREFIX}${roomId}`;
    await redis.srem(roomKey, socketId);
    await redis.del(`${this.SOCKET_PREFIX}${socketId}`);

    // Check if room is empty and delete it
    const size = await redis.scard(roomKey);
    if (size === 0) {
      await redis.del(roomKey);
    }

    return roomId;
  }

  async getRoomUserIds(roomId: string): Promise<string[]> {
    const redis = this.redisService.getPubClient();
    const roomKey = `${this.ROOM_PREFIX}${roomId}`;
    return redis.smembers(roomKey);
  }

  async getRoomSize(roomId: string): Promise<number> {
    const redis = this.redisService.getPubClient();
    const roomKey = `${this.ROOM_PREFIX}${roomId}`;
    return redis.scard(roomKey);
  }

  private async generateRoomId(): Promise<string> {
    const redis = this.redisService.getPubClient();
    const counter = await redis.incr(this.ROOM_COUNTER_KEY);
    return `room_${counter}`;
  }
}
