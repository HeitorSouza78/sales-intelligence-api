import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ActionItemType, MeetingStatus } from '@prisma/client';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeetingsGateway } from './meetings.gateway.js';
import { MeetingsService } from './meetings.service.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi
    .fn()
    .mockResolvedValue('https://signed-s3-url.example/original.mp4'),
}));

const OWNER_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'b2b2b2b2-0000-4000-8000-000000000002';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_AUDIO = `s3://test-bucket/meetings/${OWNER_ID}/${MEETING_ID}/audio.mp3`;

describe('MeetingsService & MeetingsGateway', () => {
  const createService = () => {
    const tx = {
      meeting: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: MEETING_ID, userId: OWNER_ID }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn(),
      },
      user: { upsert: vi.fn() },
      complianceScore: { upsert: vi.fn().mockResolvedValue({}) },
      actionItem: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const findManyMock = vi.fn().mockResolvedValue([
      {
        id: MEETING_ID,
        title: 'Reunião iFood',
        status: MeetingStatus.COMPLETED,
        createdAt: new Date('2026-11-17T10:00:00Z'),
      },
    ]);
    const findFirstMock = vi.fn().mockResolvedValue({
      id: MEETING_ID,
      title: 'Reunião iFood',
      scheduledAt: new Date('2026-11-17T10:00:00Z'),
      videoUrl: `s3://test-bucket/meetings/${OWNER_ID}/${MEETING_ID}/original.mp4`,
      audioUrl: OWNER_AUDIO,
      status: MeetingStatus.COMPLETED,
      userId: OWNER_ID,
      createdAt: new Date('2026-11-17T10:00:00Z'),
      updatedAt: new Date('2026-11-17T10:05:00Z'),
      complianceScore: {
        id: '33333333-3333-4333-8333-333333333333',
        score: '90.00',
        notes: 'Resumo: Teste\n\nPalavras-chave: iFood, orçamento',
        createdAt: new Date('2026-11-17T10:05:00Z'),
        updatedAt: new Date('2026-11-17T10:05:00Z'),
      },
      actionItems: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          type: ActionItemType.TASK,
          description: 'Orçamento entre R$ 25.000 e R$ 30.000',
          createdAt: new Date('2026-11-17T10:05:00Z'),
          updatedAt: new Date('2026-11-17T10:05:00Z'),
        },
      ],
    });

    const prisma = {
      meeting: { findMany: findManyMock, findFirst: findFirstMock },
      $transaction: vi.fn(
        async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
      ),
    } as unknown as PrismaService;

    const roomEmit = vi.fn();
    const serverTo = vi.fn(() => ({ emit: roomEmit }));
    const serverEmit = vi.fn();
    const gateway = new MeetingsGateway({} as JwtService);
    (gateway as unknown as { server: unknown }).server = {
      to: serverTo,
      emit: serverEmit,
    };

    const config = {
      get: vi.fn(() => undefined),
      getOrThrow: vi.fn((key: string) => {
        if (key === 'S3_BUCKET_NAME') return 'test-bucket';
        if (key === 'AWS_REGION') return 'us-east-2';
        return 'test';
      }),
    } as unknown as ConfigService;

    const service = new MeetingsService(prisma, gateway, config);
    return {
      service,
      tx,
      prisma,
      findManyMock,
      findFirstMock,
      serverTo,
      roomEmit,
      serverEmit,
    };
  };

  it('lista apenas as reuniões do usuário do JWT', async () => {
    const { service, findManyMock } = createService();
    const items = await service.findAllByUser(OWNER_ID);

    expect(items).toHaveLength(1);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: OWNER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, createdAt: true },
    });
  });

  it('retorna detalhes com Presigned URL filtrando por id + userId', async () => {
    const { service, findFirstMock } = createService();
    const detail = await service.findOneById(MEETING_ID, OWNER_ID);

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MEETING_ID, userId: OWNER_ID } }),
    );
    expect(detail.videoUrl).toBe(
      'https://signed-s3-url.example/original.mp4',
    );
    expect(detail.complianceScore?.score).toBe(90);
  });

  it('IDOR: outro usuário recebe 404 e nenhuma Presigned URL é gerada', async () => {
    const { service, findFirstMock } = createService();
    findFirstMock.mockResolvedValueOnce(null);

    await expect(
      service.findOneById(MEETING_ID, OTHER_USER_ID),
    ).rejects.toThrow(NotFoundException);
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEETING_ID, userId: OTHER_USER_ID },
      }),
    );
  });

  it('webhook salva e emite meeting.analyzed SOMENTE para a sala do dono', async () => {
    const { service, serverTo, roomEmit, serverEmit } = createService();

    const result = await service.processAwsWebhook({
      meetingId: MEETING_ID,
      status: MeetingStatus.COMPLETED,
      audioUrl: OWNER_AUDIO,
      complianceScore: 90,
      type: 'FOLLOW_UP',
      actionItems: ['R$ 25.000 a R$ 30.000', 'aprovar até sexta-feira'],
    });

    expect(result).toEqual({ meetingId: MEETING_ID });
    expect(serverEmit).not.toHaveBeenCalled();
    expect(serverTo).toHaveBeenCalledWith(OWNER_ID);
    expect(roomEmit).toHaveBeenCalledWith('meeting.analyzed', {
      meetingId: MEETING_ID,
      status: MeetingStatus.COMPLETED,
      complianceScore: 90,
      type: 'FOLLOW_UP',
      notes: 'Categoria: FOLLOW_UP',
      audioUrl: OWNER_AUDIO,
      actionItems: [
        { type: ActionItemType.TASK, description: 'R$ 25.000 a R$ 30.000' },
        { type: ActionItemType.TASK, description: 'aprovar até sexta-feira' },
      ],
    });
  });

  it('webhook para reunião inexistente retorna 404 e NÃO cria usuário/reunião', async () => {
    const { service, tx, roomEmit } = createService();
    tx.meeting.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.processAwsWebhook({
        meetingId: MEETING_ID,
        complianceScore: 80,
        actionItems: [],
      }),
    ).rejects.toThrow(NotFoundException);
    expect(tx.meeting.create).not.toHaveBeenCalled();
    expect(tx.user.upsert).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('webhook rejeita audioUrl que aponta para arquivo de outro tenant', async () => {
    const { service, tx } = createService();

    await expect(
      service.processAwsWebhook({
        meetingId: MEETING_ID,
        complianceScore: 80,
        audioUrl: `s3://test-bucket/meetings/${OTHER_USER_ID}/${MEETING_ID}/audio.mp3`,
        actionItems: [],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.meeting.update).not.toHaveBeenCalled();
  });

  it('não emite evento WebSocket se a transação no Prisma falhar', async () => {
    const { service, prisma, roomEmit } = createService();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB connection error'),
    );

    await expect(
      service.processAwsWebhook({
        meetingId: MEETING_ID,
        complianceScore: 80,
        actionItems: ['Teste'],
      }),
    ).rejects.toThrow();
    expect(roomEmit).not.toHaveBeenCalled();
  });
});
