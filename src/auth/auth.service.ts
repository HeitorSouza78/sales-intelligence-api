import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

const DEV_TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

export interface DevLoginResponse {
  access_token: string;
}

@Injectable()
export class AuthService {
  private readonly expectedCodeHash: Buffer | null;

  constructor(
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    const accessCode = config.get<string>('DEMO_ACCESS_CODE')?.trim();
    this.expectedCodeHash = accessCode ? this.hash(accessCode) : null;
  }

  /**
   * Emite um JWT para o usuário de demonstração apenas mediante código de acesso válido.
   */
  loginDev(code: string): DevLoginResponse {
    if (!this.expectedCodeHash) {
      throw new UnauthorizedException('Código de acesso não configurado no servidor');
    }

    const providedHash = this.hash(code.trim());
    if (!timingSafeEqual(providedHash, this.expectedCodeHash)) {
      throw new UnauthorizedException('Código de acesso inválido');
    }

    const payload = { sub: DEV_TEST_USER_ID };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  private hash(value: string): Buffer {
    return createHash('sha256').update(value).digest();
  }
}
