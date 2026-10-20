import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateToken(): string { return randomBytes(32).toString('hex'); }
export function isToken(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function hashSessionToken(token: string): string {
  if (!isToken(token)) throw new Error('Invalid session token.');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function matchesCsrfToken(expected: string, supplied: unknown): boolean {
  return isToken(expected) && isToken(supplied)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}
