import { Injectable } from '@nestjs/common';

export interface UserPointer {
  id: string;
  name: string;
  color: string;
  current_page: string;
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
  data: {
    path?: Array<{ x: number; y: number }>;
    sprayPoints?: Array<{ x: number; y: number }>;
    fillPoint?: { x: number; y: number };
    targetColor?: string;
    fillColor?: string;
    color?: string;
    backgroundColor?: string;
    size?: number;
  };
}

const INACTIVITY_MS = 10 * 60 * 1000;   // 10 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;  // 1 minute

@Injectable()
export class MouseService {
  private users: Map<string, UserPointer> = new Map();
  private canvasOperations: Operation[] = [];
  private disconnectedDrawingUsers: Map<string, { disconnectedAt: number }> = new Map();

  private getRandomColor(): string {
    const colors = ['#F87171', '#60A5FA', '#34D399', '#FB923C', '#A78BFA', '#F472B6'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  createUser(id: string, current_page: string): UserPointer {
    const user: UserPointer = {
      id,
      name: `User_${id.substring(0, 5)}`,
      color: this.getRandomColor(),
      current_page,
      x: 0, y: 0, scrollX: 0, scrollY: 0, pageX: 0, pageY: 0,
    };
    this.users.set(id, user);
    return user;
  }

  updateUserPosition(
    id: string,
    x: number, y: number,
    scrollX: number, scrollY: number,
    pageX: number, pageY: number,
    current_page: string,
  ): UserPointer | null {
    const user = this.users.get(id);
    if (user) {
      user.x = x; user.y = y;
      user.scrollX = scrollX; user.scrollY = scrollY;
      user.pageX = pageX; user.pageY = pageY;
      user.current_page = current_page;
      return user;
    }
    return null;
  }

  updateUserScroll(id: string, scrollX: number, scrollY: number): UserPointer | null {
    const user = this.users.get(id);
    if (user) {
      user.scrollX = scrollX; user.scrollY = scrollY;
      user.pageX = scrollX + user.x; user.pageY = scrollY + user.y;
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

  /** Call before removeUser on disconnect. Tracks users who drew for 10‑min timeout. */
  markUserDisconnected(id: string): void {
    const user = this.users.get(id);
    if (user?.lastDrawAt != null) {
      this.disconnectedDrawingUsers.set(id, { disconnectedAt: Date.now() });
    }
  }


 getCanvasState(): Operation[] {
  // Return complete operations with all fields
  return this.canvasOperations.map(op => ({
    id: op.id,
    playerId: op.playerId,
    type: op.type,
    timestamp: op.timestamp,
    data: {
      ...op.data, // Preserve all fields including fillResult
    }
  }));
}

  addOperation(op: Operation): void {
  // Don't filter or transform - store exactly as received
  this.canvasOperations.push({
    id: op.id,
    playerId: op.playerId,
    type: op.type,
    timestamp: op.timestamp,
    data: {
      ...op.data, // Preserve EVERYTHING including fillResult
    }
  });
}

  removeOperationsByPlayerId(playerId: string): Operation[] {
    this.canvasOperations = this.canvasOperations.filter((o) => o.playerId !== playerId);
    const user = this.users.get(playerId);
    if (user) user.lastDrawAt = undefined;
    return this.getCanvasState();
  }


  removeUserOperations(userId: string): Operation[] {
    // Filter out operations, but preserve all fields of remaining operations
    this.canvasOperations = this.canvasOperations.filter(
      (op) => op.playerId !== userId
    );
    // Return complete operations with all fields
    return this.canvasOperations.map(op => ({
      ...op,
      data: {
        ...op.data, // Preserve all data fields including fillResult
      }
    }));
  }

  cleanupTimeoutUsers(): { removedUserIds: string[]; canvasState: Operation[] } {
    const now = Date.now();
    const removedUserIds: string[] = [];

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
      this.removeOperationsByPlayerId(id);
    }

    return { removedUserIds, canvasState: this.getCanvasState() };
  }

  getCleanupIntervalMs(): number {
    return CLEANUP_INTERVAL_MS;
  }
}
