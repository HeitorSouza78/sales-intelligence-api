import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { vi } from 'vitest';
import { MeetingsGateway } from './meetings.gateway.js';

const SECRET = 'access-secret-test-0123456789';
const USER_ID = 'a1a1a1a1-0000-4000-8000-000000000001';

function fakeSocket(
  auth: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return {
    id: 'sock-1',
    handshake: { auth, headers },
    data: {} as Record<string, unknown>,
    join: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as Socket & {
    join: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
}

describe('MeetingsGateway handshake', () => {
  const jwt = new JwtService({ secret: SECRET });
  const gateway = new MeetingsGateway(jwt);

  it('aceita access token válido e entra na sala privada do usuário', async () => {
    const token = await jwt.signAsync(
      { sub: USER_ID, type: 'access' },
      { expiresIn: 900 },
    );
    const socket = fakeSocket({ token });

    await gateway.authenticate(socket);
    await gateway.handleConnection(socket);

    expect(socket.join).toHaveBeenCalledWith(USER_ID);
    gateway.handleDisconnect(socket);
  });

  it('aceita header Authorization: Bearer', async () => {
    const token = await jwt.signAsync(
      { sub: USER_ID, type: 'access' },
      { expiresIn: 900 },
    );
    const socket = fakeSocket({}, { authorization: `Bearer ${token}` });
    await expect(gateway.authenticate(socket)).resolves.toBeUndefined();
    gateway.handleDisconnect(socket);
  });

  it.each([
    ['sem token', {}],
    ['token inválido', { token: 'abc.def.ghi' }],
  ])('rejeita handshake %s', async (_label, auth) => {
    await expect(gateway.authenticate(fakeSocket(auth))).rejects.toThrow();
  });

  it('rejeita token assinado com outro segredo', async () => {
    const forged = await new JwtService({ secret: 'outro' }).signAsync({
      sub: USER_ID,
      type: 'access',
    });
    await expect(
      gateway.authenticate(fakeSocket({ token: forged })),
    ).rejects.toThrow();
  });

  it('rejeita refresh token e token legado sem "type"', async () => {
    const refresh = await jwt.signAsync({ sub: USER_ID, type: 'refresh' });
    const legacy = await jwt.signAsync({ sub: USER_ID });
    await expect(
      gateway.authenticate(fakeSocket({ token: refresh })),
    ).rejects.toThrow();
    await expect(
      gateway.authenticate(fakeSocket({ token: legacy })),
    ).rejects.toThrow();
  });

  it('rejeita token expirado', async () => {
    const expired = await jwt.signAsync(
      { sub: USER_ID, type: 'access' },
      { expiresIn: -10 },
    );
    await expect(
      gateway.authenticate(fakeSocket({ token: expired })),
    ).rejects.toThrow();
  });

  it('desconecta socket sem userId (defesa em profundidade)', async () => {
    const socket = fakeSocket();
    await gateway.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });
});

