import { ActionItemType, MeetingStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const MEETING_ANALYSIS_TYPES = [
  'DEMO',
  'NEGOTIATION',
  'FOLLOW_UP',
  'CLOSING',
] as const;
export type MeetingAnalysisType = (typeof MEETING_ANALYSIS_TYPES)[number];

export class ActionItemPayloadDto {
  @IsEnum(ActionItemType)
  type: ActionItemType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;
}

export class AwsWebhookDto {
  @IsUUID()
  meetingId: string;

  @IsOptional()
  @IsEnum(MeetingStatus)
  status?: MeetingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  audioUrl?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  complianceScore?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  score?: number;

  @IsOptional()
  @IsIn(MEETING_ANALYSIS_TYPES)
  type?: MeetingAnalysisType;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  complianceNotes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  notes?: string;

  @IsArray()
  @ArrayMaxSize(200)
  actionItems: Array<string | ActionItemPayloadDto>;
}
