import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AuthResponse,
  type AuthTokens,
  type JwtPayload,
  PUBLIC_USER_SELECT,
  type PublicUser,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';

// Parâmetros recomendados pela OWASP para Argon2id (m=19 MiB, t=2, p=1).
// algorithm: 2 = Algorithm.Argon2id (const enum não é acessível com isolatedModules).
const ARGON2_OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const INVALID_CREDENTIALS = 'Credenciais inválidas';
const INVALID_SESSION = 'Sessão inválida ou expirada';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshSecret: string;
  /** Hash "fantasma" usado quando o e-mail não existe, para igualar o tempo de resposta. */
  private readonly dummyHashPromise: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    if (this.refreshSecret === config.get<string>('JWT_SECRET')) {
      throw new Error('JWT_REFRESH_SECRET deve ser diferente de JWT_SECRET');
    }
    this.dummyHashPromise = hash(randomUUID(), ARGON2_OPTIONS);
  }

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await hash(dto.password, ARGON2_OPTIONS);

    let user: PublicUser;
    try {
      user = await this.prisma.user.create({
        data: { name: dto.name, email: dto.email, passwordHash },
        select: PUBLIC_USER_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('E-mail já cadastrado');
      }
      throw error;
    }

    const tokens = await this.issueTokens(user.id);
    return { user, ...tokens };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const record = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...PUBLIC_USER_SELECT, passwordHash: true },
    });

    // Sempre executa um verify (mesmo sem usuário) para não revelar,
    // pelo tempo de resposta, se o e-mail existe (user enumeration).
    const hashToCheck = record?.passwordHash ?? (await this.dummyHashPromise);
    const passwordOk = await this.safeVerify(hashToCheck, dto.password);

    if (!record || !passwordOk) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const { passwordHash: _omit, ...user } = record;
    const tokens = await this.issueTokens(user.id);
    return { user, ...tokens };
  }

  /**
   * Rotação de Refresh Token com detecção de reuso:
   * cada refresh token só pode ser usado uma vez. Se um token antigo (já
   * rotacionado) for reapresentado, assumimos roubo e revogamos a sessão.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException(INVALID_SESSION);
    }
    if (payload.type !== 'refresh' || !payload.sub) {
      throw new UnauthorizedException(INVALID_SESSION);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, refreshTokenHash: true },
    });
    if (!user?.refreshTokenHash) {
      throw new UnauthorizedException(INVALID_SESSION);
    }

    const matches = await this.safeVerify(user.refreshTokenHash, refreshToken);
    if (!matches) {
      this.logger.warn(
        `Reuso de refresh token detectado para userId=${user.id}. Sessão revogada.`,
      );
      await this.prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: null },
      });
      throw new UnauthorizedException(INVALID_SESSION);
    }

    // Compare-and-swap: só rotaciona se o hash ainda for o mesmo que validamos.
    return this.issueTokens(user.id, user.refreshTokenHash);
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) {
      throw new UnauthorizedException(INVALID_SESSION);
    }
    return user;
  }

  private async issueTokens(
    userId: string,
    expectedCurrentHash?: string,
  ): Promise<AuthTokens> {
    const accessPayload: JwtPayload = { sub: userId, type: 'access' };
    const refreshPayload: JwtPayload = {
      sub: userId,
      type: 'refresh',
      jti: randomUUID(),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        expiresIn: REFRESH_TOKEN_TTL_SECONDS,
      }),
    ]);

    const refreshTokenHash = await hash(refreshToken, ARGON2_OPTIONS);
    const result = await this.prisma.user.updateMany({
      where: {
        id: userId,
        ...(expectedCurrentHash !== undefined
          ? { refreshTokenHash: expectedCurrentHash }
          : {}),
      },
      data: { refreshTokenHash },
    });
    if (result.count === 0) {
      throw new UnauthorizedException(INVALID_SESSION);
    }

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /** verify() lança erro com hashes malformados (ex.: usuários legados do MVP). */
  private async safeVerify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain);
    } catch {
      return false;
    }
  }
}
