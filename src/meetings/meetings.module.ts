import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsGateway } from './meetings.gateway.js';
import { MeetingsService } from './meetings.service.js';
import { WebhookSecretGuard } from './webhook-secret.guard.js';

@Module({
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsGateway, WebhookSecretGuard],
})
export class MeetingsModule {}
