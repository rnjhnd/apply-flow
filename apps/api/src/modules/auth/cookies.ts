import { parseCookie, stringifySetCookie } from 'cookie';
import type { AuthConfig } from '../../config/auth.js';
import { isToken } from './tokens.js';

type Mode = AuthConfig['nodeEnv'];
export function sessionCookieName(mode: Mode): string {
  return mode === 'production' ? '__Host-applyflow_session' : 'applyflow_session';
}
function attributes(mode: Mode) {
  return { name: sessionCookieName(mode), httpOnly: true, secure: mode === 'production', sameSite: 'lax' as const, path: '/' };
}
export function createSessionCookie(mode: Mode, token: string, expiresAt: Date, now: Date): string {
  const remaining = expiresAt.getTime() - now.getTime();
  if (!isToken(token) || !Number.isFinite(remaining) || remaining < 1000) throw new Error('Invalid session cookie parameters.');
  return stringifySetCookie({ ...attributes(mode), value: token, expires: expiresAt, maxAge: Math.floor(remaining / 1000) });
}
export function clearSessionCookie(mode: Mode): string {
  return stringifySetCookie({ ...attributes(mode), value: '', expires: new Date(0), maxAge: 0 });
}
export function readSessionCookie(mode: Mode, header: string | undefined): string | null {
  if (!header) return null;
  const name = sessionCookieName(mode);
  if (header.split(';').filter((part) => part.slice(0, part.indexOf('=')).trim() === name).length > 1) {
    throw new Error('Ambiguous session cookie.');
  }
  const value = parseCookie(header, { decode: (raw) => raw })[name];
  return isToken(value) ? value : null;
}
