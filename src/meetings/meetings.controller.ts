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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
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

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll(@Req() req: AuthenticatedRequest): Promise<MeetingListItem[]> {
    return this.meetingsService.findAllByUser(req.user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MeetingDetailResponse> {
    return this.meetingsService.findOneById(id, req.user.id);
  }

  @Post('upload-url')
  @UseGuards(ThrottlerGuard, JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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
