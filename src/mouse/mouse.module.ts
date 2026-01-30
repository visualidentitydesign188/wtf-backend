import { Module } from '@nestjs/common';
import { MouseService } from './mouse.service';
import { MouseGateway } from './mouse.gateway';
import { MouseController } from './mouse.controller';
import { RoomService } from './room.service';
import { RateLimitService } from './rate-limit.service';
import { MessageThrottleService } from './message-throttle.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [
    MouseService,
    RoomService,
    RateLimitService,
    MessageThrottleService,
    MouseGateway,
  ],
  controllers: [MouseController],
})
export class MouseModule {}
