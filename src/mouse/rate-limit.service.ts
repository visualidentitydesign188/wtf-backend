import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Rate limiting service to prevent buffer overflow from too many requests.
 * Uses Redis for distributed rate limiting across multiple instances.
 */
@Injectable()
export class RateLimitService {
  private readonly DEFAULT_LIMITS = {
    // Per socket limits
    drawOpPerMinute: 60, // 60 draw operations per minute per socket
    drawOpPerSecond: 10, // 10 draw operations per second per socket
    // Per room limits (to prevent room flooding)
    roomMessagesPerSecond: 50, // 50 messages per second per room
  };

  constructor(private readonly redisService: RedisService) {}

  /**
   * Check if a socket can send a draw operation
   */
  async checkDrawOpLimit(socketId: string): Promise<RateLimitResult> {
    const now = Date.now();
    const secondKey = `rate_limit:draw_op:second:${socketId}`;
    const minuteKey = `rate_limit:draw_op:minute:${socketId}`;

    const pubClient = this.redisService.getPubClient();

    // Check per-second limit
    const secondCount = await pubClient.incr(secondKey);
    if (secondCount === 1) {
      await pubClient.expire(secondKey, 1);
    }
    if (secondCount > this.DEFAULT_LIMITS.drawOpPerSecond) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: now + 1000,
      };
    }

    // Check per-minute limit
    const minuteCount = await pubClient.incr(minuteKey);
    if (minuteCount === 1) {
      await pubClient.expire(minuteKey, 60);
    }
    const remaining = Math.max(
      0,
      this.DEFAULT_LIMITS.drawOpPerMinute - minuteCount,
    );

    if (minuteCount > this.DEFAULT_LIMITS.drawOpPerMinute) {
      return {
        allowed: false,
        remaining,
        resetAt: now + 60000,
      };
    }

    return {
      allowed: true,
      remaining,
      resetAt: now + 60000,
    };
  }

  /**
   * Check if a room can receive more messages (prevents room flooding)
   */
  async checkRoomMessageLimit(roomId: string): Promise<boolean> {
    const key = `rate_limit:room:${roomId}`;
    const pubClient = this.redisService.getPubClient();

    const count = await pubClient.incr(key);
    if (count === 1) {
      await pubClient.expire(key, 1);
    }

    return count <= this.DEFAULT_LIMITS.roomMessagesPerSecond;
  }

  /**
   * Reset rate limit for a socket (on disconnect)
   */
  async resetSocketLimits(socketId: string): Promise<void> {
    const pubClient = this.redisService.getPubClient();
    const keys = [
      `rate_limit:draw_op:second:${socketId}`,
      `rate_limit:draw_op:minute:${socketId}`,
    ];
    await Promise.all(keys.map((key) => pubClient.del(key)));
  }
}
