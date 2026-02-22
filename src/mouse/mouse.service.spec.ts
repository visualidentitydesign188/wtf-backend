import { Test, TestingModule } from '@nestjs/testing';
import { MouseService, type Operation, type UserPointer } from './mouse.service';

describe('MouseService', () => {
  let service: MouseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MouseService],
    }).compile();

    service = module.get<MouseService>(MouseService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createUser', () => {
    it('should create and store a user with random name and default fields', () => {
      const user = service.createUser('socket-1', 'home', 'room_1');
      expect(user).toMatchObject({
        id: 'socket-1',
        current_page: 'home',
        roomId: 'room_1',
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        pageX: 0,
        pageY: 0,
      });
      expect(typeof user.name).toBe('string');
      expect(user.name.length).toBeGreaterThan(0);
      expect(user.color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(service.getAllUsers()).toHaveLength(1);
    });
  });

  describe('updateUserPosition', () => {
    it('should update position and return user', () => {
      service.createUser('u1', 'page', 'room_1');
      const updated = service.updateUserPosition('u1', 10, 20, 5, 5, 15, 25, 'other');
      expect(updated).toMatchObject({
        id: 'u1',
        x: 10,
        y: 20,
        scrollX: 5,
        scrollY: 5,
        pageX: 15,
        pageY: 25,
        current_page: 'other',
      });
    });

    it('should return null for unknown user', () => {
      expect(service.updateUserPosition('unknown', 0, 0, 0, 0, 0, 0, '')).toBeNull();
    });
  });

  describe('updateUserScroll', () => {
    it('should update scroll and derived page position', () => {
      service.createUser('u1', 'p', 'r1');
      service.updateUserPosition('u1', 100, 50, 0, 0, 100, 50, 'p');
      const updated = service.updateUserScroll('u1', 10, 20);
      expect(updated).toMatchObject({ scrollX: 10, scrollY: 20, pageX: 110, pageY: 70 });
    });

    it('should return null for unknown user', () => {
      expect(service.updateUserScroll('unknown', 0, 0)).toBeNull();
    });
  });

  describe('removeUser', () => {
    it('should remove user and return true', () => {
      service.createUser('u1', 'p', 'r1');
      expect(service.removeUser('u1')).toBe(true);
      expect(service.getAllUsers()).toHaveLength(0);
    });

    it('should return false when user does not exist', () => {
      expect(service.removeUser('none')).toBe(false);
    });
  });

  describe('getAllUsers / getUsersInRoom', () => {
    it('should return users in room', () => {
      service.createUser('a', 'p', 'room_1');
      service.createUser('b', 'p', 'room_1');
      service.createUser('c', 'p', 'room_2');
      expect(service.getAllUsers()).toHaveLength(3);
      expect(service.getUsersInRoom('room_1')).toHaveLength(2);
      expect(service.getUsersInRoom('room_2')).toHaveLength(1);
    });
  });

  describe('markUserDisconnected', () => {
    it('should track disconnected user only if they had lastDrawAt', () => {
      service.createUser('u1', 'p', 'r1');
      const u = service.getAllUsers()[0] as UserPointer & { lastDrawAt?: number };
      u.lastDrawAt = Date.now();
      service.markUserDisconnected('u1');
      // No public API to read disconnectedDrawingUsers; we just ensure no throw
      service.markUserDisconnected('unknown');
      service.markUserDisconnected('u1');
    });
  });

  describe('getCanvasState', () => {
    it('should return empty array for unknown room', () => {
      expect(service.getCanvasState('room_x')).toEqual([]);
    });

    it('should return operations sorted by timestamp then id', () => {
      const op1: Operation = {
        id: 'a',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 100,
        data: {},
      };
      const op2: Operation = {
        id: 'b',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 50,
        data: {},
      };
      service.addOperation('room_1', op1);
      service.addOperation('room_1', op2);
      const state = service.getCanvasState('room_1');
      expect(state.map((o) => o.id)).toEqual(['b', 'a']);
    });
  });

  describe('addOperation', () => {
    it('should add operation and set timestamp if missing', () => {
      const op: Operation = {
        id: 'op1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 0,
        data: {},
      };
      (op as { timestamp?: number }).timestamp = undefined as unknown as number;
      service.addOperation('room_1', op);
      expect(op.timestamp).toBeGreaterThan(0);
      expect(service.getCanvasState('room_1')).toHaveLength(1);
    });

    it('should update existing operation by id and preserve fillResult', () => {
      const fillOp: Operation = {
        id: 'f1',
        playerId: 'p1',
        type: 'fillColor',
        timestamp: 1,
        data: { fillResult: { cells: 10 } },
      };
      service.addOperation('room_1', fillOp);
      const updateOp: Operation = {
        id: 'f1',
        playerId: 'p1',
        type: 'fillColor',
        timestamp: 2,
        data: {},
      };
      service.addOperation('room_1', updateOp);
      const state = service.getCanvasState('room_1');
      expect(state).toHaveLength(1);
      expect(state[0].data.fillResult).toEqual({ cells: 10 });
    });

    it('should insert operations in timestamp order', () => {
      service.addOperation('room_1', {
        id: 'c',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 30,
        data: {},
      });
      service.addOperation('room_1', {
        id: 'a',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 10,
        data: {},
      });
      service.addOperation('room_1', {
        id: 'b',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 20,
        data: {},
      });
      const state = service.getCanvasState('room_1');
      expect(state.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('removeOperationsByPlayerId', () => {
    it('should remove ops by player and return new canvas state', () => {
      service.addOperation('room_1', {
        id: '1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      service.addOperation('room_1', {
        id: '2',
        playerId: 'p2',
        type: 'pencil',
        timestamp: 2,
        data: {},
      });
      const state = service.removeOperationsByPlayerId('room_1', 'p1');
      expect(state).toHaveLength(1);
      expect(state[0].playerId).toBe('p2');
    });

    it('should clear lastDrawAt for user if present', () => {
      service.createUser('p1', 'p', 'room_1');
      const u = service.getAllUsers()[0] as UserPointer & { lastDrawAt?: number };
      u.lastDrawAt = 123;
      service.addOperation('room_1', {
        id: '1',
        playerId: 'p1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      service.removeOperationsByPlayerId('room_1', 'p1');
      expect(u.lastDrawAt).toBeUndefined();
    });
  });

  describe('removeUserOperations', () => {
    it('should return empty array for unknown user', () => {
      expect(service.removeUserOperations('unknown')).toEqual([]);
    });

    it('should remove ops for user and return new state', () => {
      service.createUser('u1', 'p', 'room_1');
      service.addOperation('room_1', {
        id: '1',
        playerId: 'u1',
        type: 'pencil',
        timestamp: 1,
        data: {},
      });
      const state = service.removeUserOperations('u1');
      expect(state).toHaveLength(0);
    });
  });

  describe('cleanupTimeoutUsers', () => {
    it('should return removedUserIds and canvasStateByRoom', () => {
      const result = service.cleanupTimeoutUsers();
      expect(result).toHaveProperty('removedUserIds');
      expect(result).toHaveProperty('canvasStateByRoom');
      expect(Array.isArray(result.removedUserIds)).toBe(true);
      expect(result.canvasStateByRoom).toBeInstanceOf(Map);
    });
  });

  describe('getCleanupIntervalMs', () => {
    it('should return positive number', () => {
      expect(service.getCleanupIntervalMs()).toBe(60 * 1000);
    });
  });
});
