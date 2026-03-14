import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface UserPointer {
  id: string;
  name: string;
  color: string;
  current_page: string;
  roomId: string;
  x: number;
  y: number;
  scrollX?: number;
  scrollY?: number;
  pageX?: number;
  pageY?: number;
  lastDrawAt?: number;
}

export type OperationType = 'pencil' | 'sprayPaint' | 'fillColor' | 'eraser';

export interface Operation {
  id: string;
  playerId: string;
  type: OperationType;
  timestamp: number;
  sequence?: number;
  data: {
    path?: Array<{ x: number; y: number }>;
    sprayPoints?: Array<{ x: number; y: number }>;
    fillPoint?: { x: number; y: number };
    targetColor?: string;
    fillColor?: string;
    color?: string;
    backgroundColor?: string;
    size?: number;
    fillResult?: any;
  };
}

const CANVAS_TTL = 3600;
const USER_PROFILE_TTL = 3600;
const ROOM_PREFIX = 'room:';

@Injectable()
export class MouseService {
  private readonly CANVAS_KEY = 'canvas:';
  private readonly USER_PROFILE_KEY = 'userprofile:';

  /** Local in-memory map for fast access on the instance that owns the socket */
  private localUsers: Map<string, UserPointer> = new Map();

  private static readonly RANDOM_NAMES = [
    'Happy Panda',
    'Swift Fox',
    'Calm Llama',
    'Bold Eagle',
    'Cheerful Otter',
    'Clever Raven',
    'Cozy Badger',
    'Daring Wolf',
    'Gentle Deer',
    'Lucky Hare',
    'Mighty Bear',
    'Nimble Squirrel',
    'Peaceful Owl',
    'Quick Ferret',
    'Silent Lynx',
    'Sunny Bee',
    'Wise Crow',
    'Brave Hawk',
    'Curious Cat',
    'Jolly Penguin',
  ] as const;

  constructor(private readonly redisService: RedisService) {}

  /**
   * Parse JSON from Redis, returning fallback on malformed data.
   * Deletes the corrupt key so the error doesn't repeat.
   */
  private async safeParse<T>(
    key: string,
    raw: string,
    fallback: T,
  ): Promise<T> {
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`Corrupt JSON in Redis key "${key}", deleting key`);
      const redis = this.redisService.getPubClient();
      await redis.del(key);
      return fallback;
    }
  }

  private getRandomColor(): string {
    const colors = [
      '#2A2A2A',
      '#C53B3A',
      '#0C9367',
      '#09407E',
      '#F1B333',
      '#F07633',
      '#6758A5',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private getRandomName(): string {
    return MouseService.RANDOM_NAMES[
      Math.floor(Math.random() * MouseService.RANDOM_NAMES.length)
    ];
  }

  // ── User profile methods ──────────────────────────────────────────

  async createUser(
    id: string,
    current_page: string,
    roomId: string,
  ): Promise<UserPointer> {
    const name = this.getRandomName();
    const color = this.getRandomColor();
    const user: UserPointer = {
      id,
      name: name || 'Guest',
      color: color || '#94A3B8',
      current_page,
      roomId,
      x: 0,
      y: 0,
      scrollX: 0,
      scrollY: 0,
      pageX: 0,
      pageY: 0,
    };
    this.localUsers.set(id, user);

    const redis = this.redisService.getPubClient();
    const profile = { id, name: user.name, color: user.color, current_page, roomId };
    await redis.set(
      `${this.USER_PROFILE_KEY}${id}`,
      JSON.stringify(profile),
      'EX',
      USER_PROFILE_TTL,
    );
    return user;
  }

  /** Fast local lookup (same instance only — used by move_pointer) */
  getUser(id: string): UserPointer | undefined {
    return this.localUsers.get(id);
  }

  /**
   * Cross-instance lookup: returns users in a room by reading Redis.
   * Position data is not included (only profile: id, name, color, roomId).
   */
  async getUsersInRoom(roomId: string): Promise<Partial<UserPointer>[]> {
    const redis = this.redisService.getPubClient();
    const socketIds = await redis.smembers(`${ROOM_PREFIX}${roomId}`);
    if (!socketIds.length) return [];

    const pipeline = redis.pipeline();
    for (const sid of socketIds) {
      pipeline.get(`${this.USER_PROFILE_KEY}${sid}`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const users: Partial<UserPointer>[] = [];
    for (let i = 0; i < results.length; i++) {
      const [err, val] = results[i];
      if (err || !val) continue;
      const key = `${this.USER_PROFILE_KEY}${socketIds[i]}`;
      const parsed = await this.safeParse<Partial<UserPointer> | null>(
        key,
        val as string,
        null,
      );
      if (parsed) users.push(parsed);
    }
    return users;
  }

  updateUserPosition(
    id: string,
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
    pageX: number,
    pageY: number,
    current_page: string,
  ): UserPointer | null {
    const user = this.localUsers.get(id);
    if (user) {
      user.x = x;
      user.y = y;
      user.scrollX = scrollX;
      user.scrollY = scrollY;
      user.pageX = pageX;
      user.pageY = pageY;
      user.current_page = current_page;
      return user;
    }
    return null;
  }

  updateUserScroll(
    id: string,
    scrollX: number,
    scrollY: number,
  ): UserPointer | null {
    const user = this.localUsers.get(id);
    if (user) {
      user.scrollX = scrollX;
      user.scrollY = scrollY;
      user.pageX = scrollX + user.x;
      user.pageY = scrollY + user.y;
      return user;
    }
    return null;
  }

  async removeUser(id: string): Promise<boolean> {
    const redis = this.redisService.getPubClient();
    await redis.del(`${this.USER_PROFILE_KEY}${id}`);
    return this.localUsers.delete(id);
  }

  /**
   * Refresh TTLs for all Redis keys associated with a room.
   * Call on user join so that active rooms never expire mid-session.
   */
  async refreshRoomTTLs(roomId: string): Promise<void> {
    const redis = this.redisService.getPubClient();
    const pipeline = redis.pipeline();

    pipeline.expire(`${this.CANVAS_KEY}${roomId}`, CANVAS_TTL);

    const socketIds = await redis.smembers(`${ROOM_PREFIX}${roomId}`);
    for (const sid of socketIds) {
      pipeline.expire(`${this.USER_PROFILE_KEY}${sid}`, USER_PROFILE_TTL);
    }

    await pipeline.exec();
  }

  // ── Canvas state methods (Redis-backed) ───────────────────────────

  async getCanvasState(roomId: string): Promise<Operation[]> {
    const redis = this.redisService.getPubClient();
    const key = `${this.CANVAS_KEY}${roomId}`;
    const data = await redis.get(key);
    if (!data) return [];
    const ops = await this.safeParse<Operation[]>(key, data, []);
    if (!ops.length) return [];
    return ops.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Add one or more operations to a room's canvas state in Redis.
   * Reads the current state, merges in the new ops (dedup + sorted insert),
   * and writes the full state back. One Redis round-trip per call.
   */
  async addOperations(roomId: string, newOps: Operation[]): Promise<void> {
    const redis = this.redisService.getPubClient();
    const key = `${this.CANVAS_KEY}${roomId}`;
    const data = await redis.get(key);
    const ops: Operation[] = data
      ? await this.safeParse<Operation[]>(key, data, [])
      : [];

    for (const op of newOps) {
      if (typeof op.timestamp !== 'number') op.timestamp = Date.now();

      const existingIndex = ops.findIndex((o) => o.id === op.id);
      if (existingIndex >= 0) {
        const existing = ops[existingIndex];
        if (
          existing.type === 'fillColor' &&
          existing.data?.fillResult &&
          !op.data?.fillResult
        ) {
          op.data.fillResult = existing.data.fillResult;
        }
        ops[existingIndex] = op;
      } else {
        let insertIndex = ops.length;
        for (let i = ops.length - 1; i >= 0; i--) {
          if (ops[i].timestamp <= op.timestamp) {
            if (ops[i].timestamp === op.timestamp && ops[i].id > op.id) continue;
            insertIndex = i + 1;
            break;
          }
        }
        ops.splice(insertIndex, 0, op);
      }
    }

    await redis.set(key, JSON.stringify(ops), 'EX', CANVAS_TTL);
  }

  async removeUserOperations(userId: string): Promise<Operation[]> {
    const user = this.localUsers.get(userId);
    const roomId = user?.roomId;
    if (!roomId) {
      const redis = this.redisService.getPubClient();
      const profileKey = `${this.USER_PROFILE_KEY}${userId}`;
      const profileData = await redis.get(profileKey);
      if (!profileData) return [];
      const profile = await this.safeParse<{ roomId?: string } | null>(
        profileKey,
        profileData,
        null,
      );
      if (!profile?.roomId) return [];
      return this.removeOperationsByPlayerId(profile.roomId, userId);
    }
    if (user) user.lastDrawAt = undefined;
    return this.removeOperationsByPlayerId(roomId, userId);
  }

  async removeOperationsByPlayerId(
    roomId: string,
    playerId: string,
  ): Promise<Operation[]> {
    const redis = this.redisService.getPubClient();
    const key = `${this.CANVAS_KEY}${roomId}`;
    const data = await redis.get(key);
    if (!data) return [];

    const ops = await this.safeParse<Operation[]>(key, data, []);
    if (!ops.length) return [];
    const filtered = ops.filter((o) => o.playerId !== playerId);
    await redis.set(key, JSON.stringify(filtered), 'EX', CANVAS_TTL);

    return filtered.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
  }
}
