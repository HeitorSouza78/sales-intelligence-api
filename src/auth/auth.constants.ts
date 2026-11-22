import type { Plan, Prisma, UserRole } from '@prisma/client';

/** Access Token curto: limita a janela de abuso caso vaze. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutos
/** Refresh Token longo, rotacionado a cada uso e revogável (hash no banco). */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 dias

export type TokenType = 'access' | 'refresh';

export interface JwtPayload {
  sub: string;
  type: TokenType;
  jti?: string;
}

/**
 * Allowlist de campos públicos do usuário.
 * passwordHash e refreshTokenHash NUNCA são selecionados aqui, então
 * é impossível que vazem em respostas que usem este select.
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  plan: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  plan: Plan;
  createdAt: Date;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface AuthResponse extends AuthTokens {
  user: PublicUser;
}

