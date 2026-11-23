import { randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionItemType, MeetingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AwsWebhookDto } from './dto/aws-webhook.dto.js';
import {
  CreateUploadUrlDto,
  MAX_FILE_SIZE_BYTES,
  UploadUrlResponse,
} from './dto/create-upload-url.dto.js';
import { MeetingsGateway } from './meetings.gateway.js';

const ALLOWED_CONTENT_TYPE = 'video/mp4';
const PRESIGNED_URL_TTL_SECONDS = 15 * 60;
const READ_PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hora para reprodução no player

export interface MeetingListItem {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: Date;
}

export interface MeetingDetailResponse {
  id: string;
  title: string;
  scheduledAt: Date;
  videoUrl: string;
  audioUrl: string | null;
  status: MeetingStatus;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  complianceScore: {
    id: string;
    score: number;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  actionItems: Array<{
    id: string;
    type: ActionItemType;
    description: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meetingsGateway: MeetingsGateway,
    config: ConfigService,
  ) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET_NAME');
    const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
    const sessionToken = config.get<string>('AWS_SESSION_TOKEN');

    // Usa credenciais do .env quando definidas localmente; em produção (EC2/ECS) usa IAM Role.
    // requestChecksumCalculation: 'WHEN_REQUIRED' evita x-amz-checksum-crc32=AAAAAA== em Presigned URLs.
    this.s3 = new S3Client({
      region: config.getOrThrow<string>('AWS_REGION'),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      ...(accessKeyId && secretAccessKey
        ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
        : {}),
    });
  }

  async findAllByUser(userId: string): Promise<MeetingListItem[]> {
    return this.prisma.meeting.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async findOneById(
    id: string,
    userId: string,
  ): Promise<MeetingDetailResponse> {
    const meeting = await this.prisma.meeting.findFirst({
      where: { id, userId },
      include: {
        complianceScore: true,
        actionItems: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!meeting) {
      throw new NotFoundException(`Meeting ${id} not found`);
    }

    const signedVideoUrl = await this.generateReadPresignedUrl(
      meeting.videoUrl,
    );

    return {
      ...meeting,
      videoUrl: signedVideoUrl,
      complianceScore: meeting.complianceScore
        ? {
          id: meeting.complianceScore.id,
          score: Number(meeting.complianceScore.score),
          notes: meeting.complianceScore.notes,
          createdAt: meeting.complianceScore.createdAt,
          updatedAt: meeting.complianceScore.updatedAt,
        }
        : null,
      actionItems: meeting.actionItems.map((item) => ({
        id: item.id,
        type: item.type,
        description: item.description,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    };
  }

  private async generateReadPresignedUrl(storedUrl: string): Promise<string> {
    const { bucket, key } = this.extractS3Location(storedUrl);

    try {
      return await getSignedUrl(
        this.s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
        { expiresIn: READ_PRESIGNED_URL_TTL_SECONDS },
      );
    } catch (error) {
      this.logger.error(
        `Failed to generate read presigned URL for ${storedUrl}`,
        error,
      );
      throw new InternalServerErrorException(
        'Could not generate video playback URL',
      );
    }
  }

  private extractS3Location(storedUrl: string): {
    bucket: string;
    key: string;
  } {
    if (storedUrl.startsWith('s3://')) {
      const withoutScheme = storedUrl.slice('s3://'.length);
      const slashIndex = withoutScheme.indexOf('/');
      if (slashIndex > 0) {
        return {
          bucket: withoutScheme.slice(0, slashIndex),
          key: withoutScheme.slice(slashIndex + 1),
        };
      }
    }

    // Fallback caso tenha sido salva uma URL HTTPS do S3 no banco
    try {
      const parsed = new URL(storedUrl);
      const key = parsed.pathname.replace(/^\/+/, '');
      const hostParts = parsed.hostname.split('.');
      const bucket =
        hostParts.length >= 4 && hostParts[1] === 's3'
          ? hostParts[0]
          : this.bucket;
      return { bucket, key };
    } catch {
      return { bucket: this.bucket, key: storedUrl.replace(/^\/+/, '') };
    }
  }

  async createUploadUrl(
    userId: string,
    dto: CreateUploadUrlDto,
  ): Promise<UploadUrlResponse> {
    // Defesa em profundidade: revalida mesmo com o ValidationPipe.
    if (!Number.isInteger(dto.fileSize) || dto.fileSize <= 0) {
      throw new BadRequestException('fileSize must be a positive integer');
    }
    if (dto.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new HttpException(
        'File exceeds the 2GB limit',
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    const meetingId = randomUUID();
    // A chave é gerada pelo servidor: o cliente nunca controla o path no S3.
    const key = `meetings/${userId}/${meetingId}/original.mp4`;
    // O @aws-sdk/s3-request-presigner promove Metadata.plan para a query string
    // assinada (&x-amz-meta-plan=...). Enviar x-amz-meta-plan também como header
    // HTTP faz o S3 rejeitar o PUT com 403 AccessDenied (HeadersNotSigned).
    const requiredHeaders: Record<string, string> = {
      'Content-Type': ALLOWED_CONTENT_TYPE,
    };

    let uploadUrl: string;
    try {
      // ContentType, ContentLength e Metadata.plan (x-amz-meta-plan) entram
      // na assinatura SigV4: o S3 rejeita qualquer tentativa de adulterar o plano.
      uploadUrl = await getSignedUrl(
        this.s3,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: ALLOWED_CONTENT_TYPE,
          ContentLength: dto.fileSize,
          Metadata: { plan: user.plan },
        }),
        { expiresIn: PRESIGNED_URL_TTL_SECONDS },
      );
    } catch (error) {
      this.logger.error('Failed to generate presigned URL', error);
      throw new InternalServerErrorException('Could not generate upload URL');
    }

    try {
      // userId vem SEMPRE do JWT validado; nunca do corpo da requisição.
      await this.prisma.meeting.create({
        data: {
          id: meetingId,
          title: dto.title.trim(),
          scheduledAt: new Date(),
          videoUrl: `s3://${this.bucket}/${key}`,
          status: MeetingStatus.PENDING,
          userId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new UnauthorizedException('User no longer exists');
      }
      this.logger.error('Failed to create meeting', error);
      throw new InternalServerErrorException('Could not create meeting');
    }

    return {
      meetingId,
      uploadUrl,
      contentType: ALLOWED_CONTENT_TYPE,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      requiredHeaders,
    };
  }

  async processAwsWebhook(dto: AwsWebhookDto): Promise<{ meetingId: string }> {
    const resolvedScore = dto.complianceScore ?? dto.score;
    if (resolvedScore === undefined) {
      throw new BadRequestException(
        'Either complianceScore or score must be provided',
      );
    }

    this.logger.log(
      `[AWS Webhook Recebido] meetingId=${dto.meetingId} | status=${dto.status ?? 'COMPLETED'} | score=${resolvedScore} | type=${dto.type ?? 'N/A'} | actionItems=${JSON.stringify(dto.actionItems)}`,
    );

    const resolvedNotes =
      dto.notes ??
      dto.complianceNotes ??
      (dto.type ? `Categoria: ${dto.type}` : null);

    const normalizedActionItems = dto.actionItems
      .map((item) => {
        if (typeof item === 'string') {
          return {
            meetingId: dto.meetingId,
            type: ActionItemType.TASK,
            description: item.trim(),
          };
        }
        return {
          meetingId: dto.meetingId,
          type: item.type ?? ActionItemType.TASK,
          description: String(item.description ?? '').trim(),
        };
      })
      .filter((item) => item.description.length > 0);

    try {
      const ownerUserId = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.meeting.findUnique({
          where: { id: dto.meetingId },
          select: { id: true, userId: true },
        });

        // Sem fallback: o webhook nunca cria reuniões nem atribui dono arbitrário.
        if (!existing) {
          throw new NotFoundException(`Meeting ${dto.meetingId} not found`);
        }

        // Garante que o audioUrl pertence ao prefixo do dono e da reunião.
        if (
          dto.audioUrl &&
          !dto.audioUrl.includes(`meetings/${existing.userId}/${existing.id}/`)
        ) {
          throw new BadRequestException(
            'audioUrl does not belong to this meeting',
          );
        }

        await tx.meeting.update({
          where: { id: dto.meetingId },
          data: {
            status: dto.status ?? MeetingStatus.COMPLETED,
            ...(dto.audioUrl ? { audioUrl: dto.audioUrl } : {}),
          },
        });

        await tx.complianceScore.upsert({
          where: { meetingId: dto.meetingId },
          update: {
            score: resolvedScore,
            notes: resolvedNotes,
          },
          create: {
            meetingId: dto.meetingId,
            score: resolvedScore,
            notes: resolvedNotes,
          },
        });

        await tx.actionItem.deleteMany({
          where: { meetingId: dto.meetingId },
        });

        if (normalizedActionItems.length > 0) {
          await tx.actionItem.createMany({
            data: normalizedActionItems,
          });
        }

        return existing.userId;
      });

      this.logger.log(
        `[AWS Webhook Salvo com Sucesso] meetingId=${dto.meetingId} | score=${resolvedScore} | itens=${normalizedActionItems.length}`,
      );

      this.meetingsGateway.emitMeetingAnalyzed(ownerUserId, {
        meetingId: dto.meetingId,
        status: dto.status ?? MeetingStatus.COMPLETED,
        complianceScore: resolvedScore,
        type: dto.type ?? null,
        notes: resolvedNotes,
        actionItems: normalizedActionItems.map(({ type, description }) => ({
          type,
          description,
        })),
        ...(dto.audioUrl ? { audioUrl: dto.audioUrl } : {}),
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Webhook failed for meeting ${dto.meetingId}`, error);
      throw new InternalServerErrorException('Could not process webhook');
    }

    return { meetingId: dto.meetingId };
  }
}
