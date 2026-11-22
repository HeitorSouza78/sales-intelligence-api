import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { JwtPayload } from './auth.constants.js';
import type { AuthenticatedUser } from './jwt-auth.guard.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      algorithms: ['HS256'],
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    // Só Access Tokens são aceitos nas rotas protegidas (refresh tokens e
    // tokens legados sem `type` são rejeitados).
    if (!payload?.sub || payload.type !== 'access') {
      throw new UnauthorizedException('Token JWT inválido');
    }
    return { id: payload.sub };
  }
}
