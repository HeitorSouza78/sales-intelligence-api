import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ActionItemType, MeetingStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
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

@WebSocketGateway({
  cors: {
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
    ],
    credentials: true,
  },
})
export class MeetingsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MeetingsGateway.name);

  @WebSocketServer()
  private readonly server: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Cliente WebSocket conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Cliente WebSocket desconectado: ${client.id}`);
  }

  /**
   * Notifica todos os clientes conectados quando uma reunião finaliza a análise da IA.
   */
  emitMeetingAnalyzed(payload: MeetingAnalyzedEvent): void {
    this.server.emit('meeting.analyzed', payload);
    this.logger.log(
      `Evento 'meeting.analyzed' emitido via WebSocket para meetingId=${payload.meetingId}`,
    );
  }
}
