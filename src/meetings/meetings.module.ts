import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsGateway } from './meetings.gateway.js';
import { MeetingsService } from './meetings.service.js';
import { WebhookSecretGuard } from './webhook-secret.guard.js';

@Module({
  imports: [AuthModule], // JwtService para autenticar o handshake do WebSocket
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsGateway, WebhookSecretGuard],
})
export class MeetingsModule { }
