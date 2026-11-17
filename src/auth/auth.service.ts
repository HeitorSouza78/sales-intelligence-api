import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

const DEV_TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

export interface DevLoginResponse {
  access_token: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  /**
   * Rota temporária para destravar o MVP enquanto a tela de login real não existe.
   */
  loginDev(): DevLoginResponse {
    const payload = { sub: DEV_TEST_USER_ID };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
