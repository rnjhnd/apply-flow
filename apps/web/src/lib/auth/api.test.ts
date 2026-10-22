import { describe, expect, it, vi } from 'vitest';
import { AuthFailure, createAuthApi, retryAfter } from './api';

const csrfToken = 'a'.repeat(64);
const user = { id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', email: 'a@example.com' };
const input = { email: ' A@Example.com ', password: ' exact password bytes ' };
function json(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
describe('same-origin authentication transport', () => {
  it('sends fixed paths/security headers, leaves Origin/Fetch Metadata to the browser, and never aborts cookie requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ csrfToken, registrationEnabled: false }))
      .mockResolvedValueOnce(json({ user, csrfToken })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createAuthApi(fetcher);
    await api.csrf(); await api.login(input, csrfToken); await api.logout(csrfToken);
    for (const [path, options] of fetcher.mock.calls) {
      expect(path).toMatch(/^\/api\/v1\/auth\/(csrf|login|logout)$/);
      expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
      expect(options?.headers).toMatchObject({ 'X-ApplyFlow-Request': '1' });
      expect(options?.headers).not.toHaveProperty('Origin');
      expect(options?.headers).not.toHaveProperty('Sec-Fetch-Site');
      expect(options).not.toHaveProperty('signal');
    }
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: input.password }) });
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe('{}');
  });
  it('bounds only the cookie-free /me read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ user }));
    expect(await createAuthApi(fetcher).me()).toEqual({ user });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('validates before fetch and does not expose submitted passwords in errors', async () => {
    const fetcher = vi.fn<typeof fetch>(); const api = createAuthApi(fetcher);
    const error = await Promise.resolve().then(() => api.register({ email: 'invalid', password: 'SECRET' }, csrfToken)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'validation', fields: ['email', 'password'] });
    expect(JSON.stringify(error)).not.toContain('SECRET');
    await expect(Promise.resolve().then(() => api.login(input, 'invalid'))).rejects.toMatchObject({ kind: 'validation' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 409, 429, 503])('sanitizes HTTP %s without retrying', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ code: 'INVALID_REQUEST', message: 'secret password token',
      fieldErrors: { email: ['private@example.com'] } }, status, { 'Retry-After': '2' }));
    const error = await createAuthApi(fetcher, () => 1000).login(input, csrfToken).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'http', status, fields: ['email'], retryAt: status === 429 ? 3000 : null });
    expect(String(error)).not.toContain('secret'); expect(JSON.stringify(error)).not.toContain('private');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { csrfToken }, { csrfToken, registrationEnabled: 'true' }, { csrfToken, registrationEnabled: true, token: 'secret' }])(
    'rejects invalid strict bootstrap response %j', async (body) => {
      await expect(createAuthApi(vi.fn<typeof fetch>().mockResolvedValue(json(body))).csrf()).rejects.toMatchObject({ kind: 'protocol' });
    });
  it('redacts network exceptions and rejects HTML, malformed JSON, wrong success codes, and secret-bearing users', async () => {
    const responses = [new Response('<html>secret</html>'), new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      json({ user, csrfToken }, 201), json({ user: { ...user, passwordHash: 'secret' }, csrfToken })];
    for (const response of responses) {
      await expect(createAuthApi(vi.fn<typeof fetch>().mockResolvedValue(response)).login(input, csrfToken)).rejects.toMatchObject({ kind: 'protocol' });
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret cookie password'));
    await expect(createAuthApi(fetcher).login(input, csrfToken)).rejects.toEqual(new AuthFailure('network'));
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('accepts exactly 201 for registration and 204 for logout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ user, csrfToken }, 201)).mockResolvedValueOnce(json({}));
    const api = createAuthApi(fetcher);
    expect(await api.register(input, csrfToken)).toEqual({ user, csrfToken });
    await expect(api.logout(csrfToken)).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('retains cooldowns even when a proxy sends malformed or HTML 429 responses', async () => {
    for (const response of [new Response('<html>private</html>', { status: 429, headers: { 'Retry-After': '5' } }),
      json({ internal: 'private' }, 429, { 'Retry-After': '5' })]) {
      const api = createAuthApi(vi.fn<typeof fetch>().mockResolvedValue(response), () => 1000);
      await expect(api.csrf()).rejects.toMatchObject({ kind: 'protocol', status: 429, retryAt: 6000 });
    }
  });
  it.each([['3', 4000], ['Thu, 01 Jan 1970 00:00:05 GMT', 5000], [null, 61000], ['bad', 61000], ['-1', 61000], ['0', 1000]])(
    'parses Retry-After %s safely', (value, expected) => { expect(retryAfter(value, 1000)).toBe(expected); });
});
