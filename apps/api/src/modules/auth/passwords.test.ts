import { describe, expect, it, vi } from 'vitest';
import { ARGON2_PARAMETERS, createPasswordService } from './passwords.js';

const phc = '$argon2id$v=19$m=65536,t=3,p=1$' + 'a'.repeat(22) + '$' + 'b'.repeat(43);
const password = 'A valid password for tests';

describe('password primitives', () => {
  it('uses the approved real Argon2id profile, distinct salts, and exact password bytes', async () => {
    const service = await createPasswordService();
    const first = await service.hash(password);
    const second = await service.hash(password);
    expect(first.split('$').slice(1, 3)).toEqual(['argon2id', 'v=19']);
    expect(first.split('$')[3]!.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
    expect(first).not.toBe(second);
    expect(await service.verify(first, password)).toBe(true);
    expect(await service.verify(first, password.toLowerCase())).toBe(false);
    const spaced = await service.hash('  ' + password + '  ');
    expect(await service.verify(spaced, '  ' + password + '  ')).toBe(true);
    expect(await service.verify(spaced, password)).toBe(false);
    const unicode = '😀'.repeat(15) + 'e\u0301';
    const unicodeHash = await service.hash(unicode);
    expect(await service.verify(unicodeHash, unicode)).toBe(true);
    expect(await service.verify(unicodeHash, '😀'.repeat(15) + 'é')).toBe(false);
    expect(await service.verify(null, password)).toBe(false);
  });
  it('checks missing accounts against the dummy hash and never accepts them', async () => {
    const backend = { hash: vi.fn().mockResolvedValue(phc), verify: vi.fn().mockResolvedValue(true) };
    const service = await createPasswordService(backend);
    expect(await service.verify(null, password)).toBe(false);
    expect(backend.verify).toHaveBeenCalledWith(phc, password);
    expect(backend.hash.mock.calls[0]?.[1]).toMatchObject({ ...ARGON2_PARAMETERS, salt: expect.any(Buffer) });
  });
  it('admits only two concurrent hash/verify operations and releases slots after errors', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const backend = { hash: vi.fn().mockResolvedValue(phc), verify: vi.fn(async () => { await pending; return false; }) };
    const service = await createPasswordService(backend);
    const first = service.verify(phc, password);
    const second = service.verify(phc, password);
    await expect(service.hash(password)).rejects.toMatchObject({ code: 'BUSY' });
    expect(backend.verify).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, second]);
    backend.hash.mockRejectedValueOnce(new Error('private-email@example.com private-password'));
    await expect(service.hash(password)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Password service is unavailable.' });
    expect(await service.hash(password)).toBe(phc);
  });
  it('rejects invalid input and corrupt or excessive-cost hashes before native verification', async () => {
    const backend = { hash: vi.fn().mockResolvedValue(phc), verify: vi.fn().mockResolvedValue(false) };
    const service = await createPasswordService(backend);
    await expect(service.hash('short')).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    await expect(service.verify(phc, '')).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    for (const digest of ['bad hash', phc.replace('65536', '999999999'), phc.replace('argon2id', 'argon2i'),
      phc.replace('t=3,p=1', 'p=1,p=1'), phc.replace('t=3,p=1', 't=3,p=1,x=1')]) {
      await expect(service.verify(digest, password)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    }
    expect(backend.verify).not.toHaveBeenCalled();
  });
});
