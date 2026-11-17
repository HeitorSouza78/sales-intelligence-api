import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActionItemType, MeetingStatus } from '@prisma/client';
import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeetingsGateway } from './meetings.gateway.js';
import { MeetingsService } from './meetings.service.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed-s3-url.example/original.mp4'),
}));

describe('MeetingsService & MeetingsGateway', () => {
  const createService = () => {
    const tx = {
      meeting: {
        findUnique: vi.fn().mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' }),
        update: vi.fn().mockResolvedValue({}),
      },
      complianceScore: {
        upsert: vi.fn().mockResolvedValue({}),
      },
      actionItem: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const findManyMock = vi.fn().mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Reunião iFood',
        status: MeetingStatus.COMPLETED,
        createdAt: new Date('2026-11-17T10:00:00Z'),
      },
    ]);
    const findFirstMock = vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Reunião iFood',
          scheduledAt: new Date('2026-11-17T10:00:00Z'),
          videoUrl:
            's3://test-bucket/meetings/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/original.mp4',
          audioUrl:
            's3://test-bucket/meetings/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/audio.mp3',
          status: MeetingStatus.COMPLETED,
          userId: '11111111-1111-4111-8111-111111111111',
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
      meeting: {
        findMany: findManyMock,
        findFirst: findFirstMock,
      },
      $transaction: vi.fn(async (cb: (client: typeof tx) => Promise<void>) => cb(tx)),
    } as unknown as PrismaService;

    const serverEmit = vi.fn();
    const gateway = new MeetingsGateway();
    (gateway as unknown as { server: { emit: typeof serverEmit } }).server = {
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
    return { service, gateway, serverEmit, prisma, findManyMock, findFirstMock };
  };

  it('deve listar reuniões leves ordenadas da mais recente para a mais antiga', async () => {
    const { service, findManyMock } = createService();
    const items = await service.findAllByUser('11111111-1111-4111-8111-111111111111');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Reunião iFood',
      status: MeetingStatus.COMPLETED,
    });
    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: '11111111-1111-4111-8111-111111111111' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, createdAt: true },
    });
  });

  it('deve retornar detalhes da reunião com Presigned URL de leitura para o vídeo', async () => {
    const { service } = createService();
    const detail = await service.findOneById(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(detail.videoUrl).toBe('https://signed-s3-url.example/original.mp4');
    expect(detail.complianceScore?.score).toBe(90);
    expect(detail.actionItems).toHaveLength(1);
  });

  it('deve lançar NotFoundException se a reunião não existir', async () => {
    const { service, findFirstMock } = createService();
    findFirstMock.mockResolvedValueOnce(null);

    await expect(
      service.findOneById(
        '99999999-9999-4999-8999-999999999999',
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('deve salvar no banco e emitir meeting.analyzed via WebSocket após o webhook', async () => {
    const { service, serverEmit } = createService();

    const result = await service.processAwsWebhook({
      meetingId: '22222222-2222-4222-8222-222222222222',
      status: MeetingStatus.COMPLETED,
      audioUrl: 's3://test-bucket/meetings/1/2/audio.mp3',
      complianceScore: 90,
      type: 'FOLLOW_UP',
      actionItems: ['R$ 25.000 a R$ 30.000', 'aprovar até sexta-feira'],
    });

    expect(result).toEqual({ meetingId: '22222222-2222-4222-8222-222222222222' });
    expect(serverEmit).toHaveBeenCalledTimes(1);
    expect(serverEmit).toHaveBeenCalledWith('meeting.analyzed', {
      meetingId: '22222222-2222-4222-8222-222222222222',
      status: MeetingStatus.COMPLETED,
      complianceScore: 90,
      type: 'FOLLOW_UP',
      notes: 'Categoria: FOLLOW_UP',
      audioUrl: 's3://test-bucket/meetings/1/2/audio.mp3',
      actionItems: [
        { type: ActionItemType.TASK, description: 'R$ 25.000 a R$ 30.000' },
        { type: ActionItemType.TASK, description: 'aprovar até sexta-feira' },
      ],
    });
  });

  it('não deve emitir evento WebSocket se a transação no Prisma falhar', async () => {
    const { service, serverEmit, prisma } = createService();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('DB connection error'),
    );

    await expect(
      service.processAwsWebhook({
        meetingId: '22222222-2222-4222-8222-222222222222',
        complianceScore: 80,
        actionItems: ['Teste'],
      }),
    ).rejects.toThrow();

    expect(serverEmit).not.toHaveBeenCalled();
  });
});
