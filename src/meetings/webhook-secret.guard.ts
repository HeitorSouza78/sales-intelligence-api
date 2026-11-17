import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/** Autentica chamadas server-to-server da AWS via header `x-webhook-secret`. */
@Injectable()
export class WebhookSecretGuard implements CanActivate {
  private readonly expectedHash: Buffer;

  constructor(config: ConfigService) {
    this.expectedHash = this.hash(config.getOrThrow<string>('AWS_WEBHOOK_SECRET'));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-webhook-secret');

    // Hash em tamanho fixo + timingSafeEqual evita timing attacks.
    if (!provided || !timingSafeEqual(this.hash(provided), this.expectedHash)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return true;
  }

  private hash(value: string): Buffer {
    return createHash('sha256').update(value).digest();
  }
}
