import { describe, expect, it } from 'vitest';
import { createSessionCookie, clearSessionCookie, readSessionCookie } from './cookies.js';
import { generateToken, hashSessionToken, isToken, matchesCsrfToken } from './tokens.js';

describe('session tokens and cookies', () => {
  it('generates independent random tokens and deterministic SHA-256 hashes', () => {
    const token = generateToken();
    expect(isToken(token)).toBe(true);
    expect(generateToken()).not.toBe(token);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb');
  });
  it.each(['', 'a'.repeat(63), 'A'.repeat(64), '%61'.repeat(64), 'secret-value'])('rejects malformed tokens (case %#)', (token) => {
    expect(isToken(token)).toBe(false);
    expect(matchesCsrfToken('a'.repeat(64), token)).toBe(false);
    expect(() => hashSessionToken(token)).toThrow('Invalid session token.');
  });
  it('compares only correctly formatted CSRF tokens', () => {
    expect(matchesCsrfToken('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(matchesCsrfToken('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(matchesCsrfToken('bad', undefined)).toBe(false);
  });
  it.each(['development', 'test', 'production'] as const)('sets and clears matching %s cookie attributes', (mode) => {
    const now = new Date('2026-01-01T00:00:00Z');
    const cookie = createSessionCookie(mode, 'a'.repeat(64), new Date(now.getTime() + 900_000), now);
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
    expect(cookie.includes('Secure')).toBe(mode === 'production');
    expect(cookie.startsWith('__Host-')).toBe(mode === 'production');
    const cleared = clearSessionCookie(mode);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    expect(cleared.includes('Secure')).toBe(mode === 'production');
    expect(cleared.split('=')[0]).toBe(cookie.split('=')[0]);
    expect(readSessionCookie(mode, cookie.split(';')[0])).toBe('a'.repeat(64));
  });
  it('does not extend cookie deadlines and rejects expired cookies', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(createSessionCookie('test', 'a'.repeat(64), new Date(now.getTime() + 1999), now)).toContain('Max-Age=1');
    expect(() => createSessionCookie('test', 'a'.repeat(64), now, now)).toThrow();
  });
  it('rejects ambiguous cookie names and ignores malformed values without disclosure', () => {
    expect(() => readSessionCookie('test', 'applyflow_session=private; applyflow_session=other')).toThrow('Ambiguous session cookie.');
    expect(readSessionCookie('test', undefined)).toBeNull();
    expect(readSessionCookie('test', 'unrelated=value')).toBeNull();
    expect(readSessionCookie('test', 'applyflow_session=%61')).toBeNull();
  });
});
