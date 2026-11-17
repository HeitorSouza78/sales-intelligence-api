import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AuthenticatedRequest,
  JwtAuthGuard,
} from '../auth/jwt-auth.guard.js';
import { AwsWebhookDto } from './dto/aws-webhook.dto.js';
import {
  CreateUploadUrlDto,
  UploadUrlResponse,
} from './dto/create-upload-url.dto.js';
import {
  type MeetingDetailResponse,
  type MeetingListItem,
  MeetingsService,
} from './meetings.service.js';
import { WebhookSecretGuard } from './webhook-secret.guard.js';

// TODO(Fase 3 - Auth): Substituir pelo req.user.id extraído do JwtAuthGuard nas rotas GET também.
const MOCK_USER_ID = '11111111-1111-4111-8111-111111111111';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  findAll(): Promise<MeetingListItem[]> {
    return this.meetingsService.findAllByUser(MOCK_USER_ID);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingDetailResponse> {
    return this.meetingsService.findOneById(id, MOCK_USER_ID);
  }

  @Post('upload-url')
  @UseGuards(JwtAuthGuard)
  createUploadUrl(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateUploadUrlDto,
  ): Promise<UploadUrlResponse> {
    return this.meetingsService.createUploadUrl(req.user.id, dto);
  }

  @Post('webhook/aws')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookSecretGuard)
  handleAwsWebhook(@Body() dto: AwsWebhookDto): Promise<{ meetingId: string }> {
    return this.meetingsService.processAwsWebhook(dto);
  }
}
