import { Test, TestingModule } from '@nestjs/testing';
import { MessageThrottleService } from './message-throttle.service';
import type { Operation } from './mouse.service';

describe('MessageThrottleService', () => {
  let service: MessageThrottleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MessageThrottleService],
    }).compile();

    service = module.get<MessageThrottleService>(MessageThrottleService);
  });

  const op = (id: string): Operation => ({
    id,
    playerId: 'p1',
    type: 'pencil',
    timestamp: Date.now(),
    data: {},
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return single op when throttle is called once', async () => {
    const operation = op('1');
    const result = await service.throttle('room_1', operation);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: '1', playerId: 'p1', type: 'pencil', data: {} });
    expect(result[0]).toBe(operation);
  });

  it('should batch multiple ops for same room and resolve after interval', async () => {
    jest.useFakeTimers();
    const p1 = service.throttle('room_1', op('1'));
    const p2 = service.throttle('room_1', op('2'));
    jest.advanceTimersByTime(60);
    const [batch1, batch2] = await Promise.all([p1, p2]);
    expect(batch1).toHaveLength(2);
    expect(batch2).toHaveLength(2);
    jest.useRealTimers();
  });

  it('should flush specific room', async () => {
    jest.useFakeTimers();
    const p = service.throttle('room_1', op('1'));
    service.flush('room_1');
    const batch = await p;
    expect(batch).toHaveLength(1);
    jest.useRealTimers();
  });

  it('should flush all rooms when no roomId', async () => {
    jest.useFakeTimers();
    const p = service.throttle('room_1', op('1'));
    service.flush();
    const batch = await p;
    expect(batch).toHaveLength(1);
    jest.useRealTimers();
  });
});
