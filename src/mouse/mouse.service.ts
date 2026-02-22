import { Injectable } from '@nestjs/common';

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
    fillResult?: any; // Compressed fill result - CRITICAL for sync
  };
}

const INACTIVITY_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class MouseService {
  private users: Map<string, UserPointer> = new Map();
  /** Canvas state per room (roomId -> operations) */
  private canvasOperationsByRoom = new Map<string, Operation[]>();
  private disconnectedDrawingUsers: Map<string, { disconnectedAt: number }> =
    new Map();

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

  private getRandomColor(): string {
    const colors = [
      '#F87171',
      '#60A5FA',
      '#34D399',
      '#FB923C',
      '#A78BFA',
      '#F472B6',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private getRandomName(): string {
    return MouseService.RANDOM_NAMES[
      Math.floor(Math.random() * MouseService.RANDOM_NAMES.length)
    ];
  }

  createUser(id: string, current_page: string, roomId: string): UserPointer {
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
    this.users.set(id, user);
    return user;
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
    const user = this.users.get(id);
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
    const user = this.users.get(id);
    if (user) {
      user.scrollX = scrollX;
      user.scrollY = scrollY;
      user.pageX = scrollX + user.x;
      user.pageY = scrollY + user.y;
      return user;
    }
    return null;
  }

  removeUser(id: string): boolean {
    return this.users.delete(id);
  }

  getAllUsers(): UserPointer[] {
    return Array.from(this.users.values());
  }

  getUser(id: string): UserPointer | undefined {
    return this.users.get(id);
  }

  getUsersInRoom(roomId: string): UserPointer[] {
    return Array.from(this.users.values()).filter((u) => u.roomId === roomId);
  }

  markUserDisconnected(id: string): void {
    const user = this.users.get(id);
    if (user?.lastDrawAt != null) {
      this.disconnectedDrawingUsers.set(id, { disconnectedAt: Date.now() });
    }
  }

  private getOrCreateRoomOps(roomId: string): Operation[] {
    let ops = this.canvasOperationsByRoom.get(roomId);
    if (!ops) {
      ops = [];
      this.canvasOperationsByRoom.set(roomId, ops);
    }
    return ops;
  }

  /** Get operations for a room sorted by TIMESTAMP */
  getCanvasState(roomId: string): Operation[] {
    const ops = this.canvasOperationsByRoom.get(roomId) ?? [];
    return [...ops].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.id.localeCompare(b.id);
    });
  }

  /** Add operation to a room in timestamp order */
  addOperation(roomId: string, op: Operation): void {
    if (typeof op.timestamp !== 'number') {
      op.timestamp = Date.now();
    }
    const canvasOperations = this.getOrCreateRoomOps(roomId);

    const existingIndex = canvasOperations.findIndex((o) => o.id === op.id);
    if (existingIndex >= 0) {
      const existing = canvasOperations[existingIndex];
      if (
        existing.type === 'fillColor' &&
        existing.data?.fillResult &&
        !op.data?.fillResult
      ) {
        op.data.fillResult = existing.data.fillResult;
      }
      canvasOperations[existingIndex] = op;
      return;
    }

    let insertIndex = canvasOperations.length;
    for (let i = canvasOperations.length - 1; i >= 0; i--) {
      const existing = canvasOperations[i];
      if (existing.timestamp <= op.timestamp) {
        if (existing.timestamp === op.timestamp && existing.id > op.id) {
          continue;
        }
        insertIndex = i + 1;
        break;
      }
    }
    canvasOperations.splice(insertIndex, 0, op);
  }

  removeOperationsByPlayerId(roomId: string, playerId: string): Operation[] {
    const ops = this.canvasOperationsByRoom.get(roomId);
    if (ops) {
      const next = ops.filter((o) => o.playerId !== playerId);
      this.canvasOperationsByRoom.set(roomId, next);
    }
    const user = this.users.get(playerId);
    if (user) user.lastDrawAt = undefined;
    return this.getCanvasState(roomId);
  }

  removeUserOperations(userId: string): Operation[] {
    const user = this.users.get(userId);
    if (!user) return [];
    const roomId = user.roomId;
    const ops = this.canvasOperationsByRoom.get(roomId);
    if (!ops) return this.getCanvasState(roomId);
    const next = ops.filter((op) => op.playerId !== userId);
    this.canvasOperationsByRoom.set(roomId, next);
    return this.getCanvasState(roomId);
  }

  cleanupTimeoutUsers(): {
    removedUserIds: string[];
    canvasStateByRoom: Map<string, Operation[]>;
  } {
    const now = Date.now();
    const removedUserIds: string[] = [];
    const canvasStateByRoom = new Map<string, Operation[]>();

    for (const [id, { disconnectedAt }] of this.disconnectedDrawingUsers) {
      if (now - disconnectedAt >= INACTIVITY_MS) {
        removedUserIds.push(id);
        this.disconnectedDrawingUsers.delete(id);
      }
    }

    for (const user of this.users.values()) {
      if (user.lastDrawAt != null && now - user.lastDrawAt >= INACTIVITY_MS) {
        removedUserIds.push(user.id);
      }
    }

    for (const id of removedUserIds) {
      const user = this.users.get(id);
      if (user) {
        this.removeOperationsByPlayerId(user.roomId, id);
        this.users.delete(id);
      }
    }

    for (const [roomId] of this.canvasOperationsByRoom) {
      canvasStateByRoom.set(roomId, this.getCanvasState(roomId));
    }
    return { removedUserIds, canvasStateByRoom };
  }

  getCleanupIntervalMs(): number {
    return CLEANUP_INTERVAL_MS;
  }
}
