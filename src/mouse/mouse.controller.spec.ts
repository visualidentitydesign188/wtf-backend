import { Test, TestingModule } from '@nestjs/testing';
import { MouseController } from './mouse.controller';
import { MouseService } from './mouse.service';

describe('MouseController', () => {
  let controller: MouseController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MouseController],
      providers: [MouseService],
    }).compile();

    controller = module.get<MouseController>(MouseController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getStatus should return Mouse is active', () => {
    expect(controller.getStatus()).toBe('Mouse is active');
  });

  it('getUsers should return user list', () => {
    expect(controller.getUsers()).toEqual(['user1', 'user2', 'user3']);
  });
});
