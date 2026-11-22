import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ActionItemType, MeetingStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/auth.constants.js';
import type { MeetingAnalysisType } from './dto/aws-webhook.dto.js';

export interface AnalyzedActionItemPayload {
  type: ActionItemType;
  description: string;
}

export interface MeetingAnalyzedEvent {
  meetingId: string;
  status: MeetingStatus;
  complianceScore: number;
  type: MeetingAnalysisType | null;
  notes: string | null;
  actionItems: AnalyzedActionItemPayload[];
  audioUrl?: string;
}

interface SocketData {
  userId: string;
  expiryTimer?: NodeJS.Timeout;
}

const DEFAULT_WS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'https://sales-intelligence-web-delta.vercel.app',
];

/**
 * Extrai o JWT do handshake. Ordem de preferência:
 * 1. `auth: { token }` do socket.io-client (não aparece em logs de URL)
 * 2. Header `Authorization: Bearer <token>`
 */
export function extractHandshakeToken(socket: Socket): string | null {
  const authToken: unknown = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.length > 0) {
    return authToken.replace(/^Bearer\s+/i, '');
  }
  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '');
  }
  return null;
}

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : DEFAULT_WS_ORIGINS,
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  },
})
export class MeetingsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(MeetingsGateway.name);

  @WebSocketServer()
  private readonly server: Server;

  constructor(private readonly jwtService: JwtService) { }

  /**
   * Middleware de handshake: valida o JWT ANTES de aceitar a conexão.
   * Token ausente/inválido/expirado => desconexão imediata (`connect_error`).
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket)
        .then(() => next())
        .catch(() => {
          this.logger.warn(`Handshake WebSocket rejeitado: ${socket.id}`);
          next(new Error('Unauthorized'));
        });
    });
  }

  async authenticate(socket: Socket): Promise<void> {
    const token = extractHandshakeToken(socket);
    if (!token) throw new Error('missing token');

    const payload = await this.jwtService.verifyAsync<
      JwtPayload & { exp?: number }
    >(token);
    if (payload.type !== 'access' || !payload.sub) {
      throw new Error('invalid token type');
    }

    const data = socket.data as SocketData;
    data.userId = payload.sub;

    // Encerra o socket automaticamente quando o Access Token expira.
    if (payload.exp) {
      const msUntilExpiry = payload.exp * 1000 - Date.now();
      data.expiryTimer = setTimeout(
        () => socket.disconnect(true),
        Math.max(msUntilExpiry, 0),
      );
    }
  }

  async handleConnection(client: Socket): Promise<void> {
    const { userId } = client.data as SocketData;
    if (!userId) {
      client.disconnect(true);
      return;
    }
    await client.join(userId);
    this.logger.log(`WebSocket conectado: socket=${client.id} userId=${userId}`);
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as Partial<SocketData>;
    if (data.expiryTimer) clearTimeout(data.expiryTimer);
    this.logger.log(`WebSocket desconectado: socket=${client.id}`);
  }

  /** Emite o resultado da análise EXCLUSIVAMENTE para a sala do dono da reunião. */
  emitMeetingAnalyzed(ownerUserId: string, payload: MeetingAnalyzedEvent): void {
    this.server.to(ownerUserId).emit('meeting.analyzed', payload);
    this.logger.log(
      `Evento 'meeting.analyzed' emitido para userId=${ownerUserId} meetingId=${payload.meetingId}`,
    );
  }
}
