import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PUBLIC_USER_SELECT } from './auth.constants.js';
import { AuthService } from './auth.service.js';

const USER_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const ACCESS_SECRET = 'access-secret-test-0123456789';
const REFRESH_SECRET = 'refresh-secret-test-9876543210';

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: 'SELLER';
  plan: 'BASIC';
  createdAt: Date;
  passwordHash: string;
  refreshTokenHash: string | null;
};

function createInMemoryPrisma() {
  const users = new Map<string, UserRow>();
  const pick = (row: UserRow, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select)
            .filter((k) => select[k])
            .map((k) => [k, row[k as keyof UserRow]]),
        )
      : row;

  const createMock = vi.fn(
    async ({
      data,
      select,
    }: {
      data: Partial<UserRow>;
      select?: Record<string, boolean>;
    }) => {
      if ([...users.values()].some((u) => u.email === data.email)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const row: UserRow = {
        id: USER_ID,
        role: 'SELLER',
        plan: 'BASIC',
        createdAt: new Date(),
        refreshTokenHash: null,
        name: data.name!,
        email: data.email!,
        passwordHash: data.passwordHash!,
      };
      users.set(row.id, row);
      return pick(row, select);
    },
  );

  const prisma = {
    user: {
      create: createMock,
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { id?: string; email?: string };
          select?: Record<string, boolean>;
        }) => {
          const row = where.id
            ? users.get(where.id)
            : [...users.values()].find((u) => u.email === where.email);
          return row ? pick(row, select) : null;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<UserRow>;
        }) => {
          const row = users.get(where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; refreshTokenHash?: string };
          data: Partial<UserRow>;
        }) => {
          const row = users.get(where.id);
          if (!row) return { count: 0 };
          if (
            where.refreshTokenHash !== undefined &&
            row.refreshTokenHash !== where.refreshTokenHash
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
  };
  return { prisma: prisma as unknown as PrismaService, users, createMock };
}

function createAuthService() {
  const { prisma, users, createMock } = createInMemoryPrisma();
  const jwt = new JwtService({ secret: ACCESS_SECRET });
  const config = {
    get: (k: string) => (k === 'JWT_SECRET' ? ACCESS_SECRET : undefined),
    getOrThrow: (k: string) =>
      k === 'JWT_REFRESH_SECRET' ? REFRESH_SECRET : ACCESS_SECRET,
  } as unknown as ConfigService;
  return { service: new AuthService(prisma, jwt, config), users, jwt, createMock };
}

const VALID = {
  name: 'Ana',
  email: 'ana@empresa.com',
  password: 'SenhaForte123',
};

describe('AuthService', () => {
  it('register: retorna tokens e NUNCA passwordHash/refreshTokenHash', async () => {
    const { service, users, createMock } = createAuthService();
    const res = await service.register(VALID);

    const json = JSON.stringify(res);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('refreshTokenHash');
    expect(json).not.toContain('$argon2');
    expect(Object.keys(res.user).sort()).toEqual(
      Object.keys(PUBLIC_USER_SELECT).sort(),
    );
    expect(res.user.plan).toBe('BASIC');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ select: PUBLIC_USER_SELECT }),
    );

    const stored = users.get(USER_ID)!;
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain(VALID.password);
    expect(stored.refreshTokenHash?.startsWith('$argon2id$')).toBe(true);
  });

  it('register: e-mail duplicado => 409 ConflictException', async () => {
    const { service } = createAuthService();
    await service.register(VALID);
    await expect(service.register(VALID)).rejects.toThrow(ConflictException);
  });

  it('login: credenciais corretas retornam access token de 15m sem hashes', async () => {
    const { service, jwt } = createAuthService();
    await service.register(VALID);
    const res = await service.login({
      email: VALID.email,
      password: VALID.password,
    });

    const payload = jwt.decode<{
      sub: string;
      type: string;
      exp: number;
      iat: number;
    }>(res.accessToken);
    expect(payload.sub).toBe(USER_ID);
    expect(payload.type).toBe('access');
    expect(payload.exp - payload.iat).toBe(15 * 60);
    expect(JSON.stringify(res)).not.toContain('passwordHash');
    expect(JSON.stringify(res)).not.toContain('refreshTokenHash');
  });

  it('login: senha errada e e-mail inexistente retornam a mesma mensagem 401', async () => {
    const { service } = createAuthService();
    await service.register(VALID);

    await expect(
      service.login({
        email: VALID.email,
        password: 'Errada123',
      }),
    ).rejects.toThrow(new UnauthorizedException('Credenciais inválidas'));
    await expect(
      service.login({
        email: 'nao@existe.com',
        password: 'Errada123',
      }),
    ).rejects.toThrow(new UnauthorizedException('Credenciais inválidas'));
  });

  it('login: usuário legado com hash inválido não quebra (retorna 401)', async () => {
    const { service, users } = createAuthService();
    await service.register(VALID);
    users.get(USER_ID)!.passwordHash = 'mvp-demo-only';
    await expect(
      service.login({ email: VALID.email, password: 'x' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refresh: rotaciona o token; reuso do token antigo revoga a sessão', async () => {
    const { service, users } = createAuthService();
    const { refreshToken: first } = await service.register(VALID);

    const rotated = await service.refresh(first);
    expect(rotated.refreshToken).not.toBe(first);

    await expect(service.refresh(first)).rejects.toThrow(UnauthorizedException);
    expect(users.get(USER_ID)!.refreshTokenHash).toBeNull();
    await expect(service.refresh(rotated.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refresh: access token não pode ser usado como refresh token', async () => {
    const { service } = createAuthService();
    const { accessToken } = await service.register(VALID);
    await expect(service.refresh(accessToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('logout: invalida o refresh token', async () => {
    const { service } = createAuthService();
    const { refreshToken } = await service.register(VALID);
    await service.logout(USER_ID);
    await expect(service.refresh(refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
