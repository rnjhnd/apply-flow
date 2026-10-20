import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../generated/prisma/client.ts';
import { ABSOLUTE_LIFETIME_MS, ANONYMOUS_LIFETIME_MS, IDLE_LIFETIME_MS, isSessionValid } from './sessions.js';
import { startSessionCleanup } from './cleanup.js';

const start = new Date('2026-01-01T00:00:00Z');
const session: Session = { id: 'fixture', tokenHash: 'a'.repeat(64), csrfToken: 'b'.repeat(64), userId: 'user',
  createdAt: start, lastSeenAt: start, expiresAt: new Date(start.getTime() + ABSOLUTE_LIFETIME_MS) };
afterEach(() => { vi.useRealTimers(); });

describe('session expiration policy', () => {
  it.each([-1, 0, 1])('checks the anonymous boundary at offset %i ms', (offset) => {
    const anonymous = { ...session, userId: null, expiresAt: new Date(start.getTime() + ANONYMOUS_LIFETIME_MS) };
    expect(isSessionValid(anonymous, new Date(start.getTime() + ANONYMOUS_LIFETIME_MS + offset))).toBe(offset < 0);
  });
  it.each([-1, 0, 1])('checks the idle boundary at offset %i ms', (offset) => {
    expect(isSessionValid(session, new Date(start.getTime() + IDLE_LIFETIME_MS + offset))).toBe(offset < 0);
  });
  it.each([-1, 0, 1])('checks the absolute boundary despite recent activity at offset %i ms', (offset) => {
    const active = { ...session, lastSeenAt: new Date(start.getTime() + ABSOLUTE_LIFETIME_MS - 1000),
      expiresAt: new Date(start.getTime() + ABSOLUTE_LIFETIME_MS * 2) };
    expect(isSessionValid(active, new Date(start.getTime() + ABSOLUTE_LIFETIME_MS + offset))).toBe(offset < 0);
  });
  it('enforces explicit earlier expiry, fixed anonymous lifetime, and valid clock', () => {
    expect(isSessionValid({ ...session, expiresAt: start }, start)).toBe(false);
    expect(isSessionValid({ ...session, userId: null, lastSeenAt: new Date(start.getTime() + ANONYMOUS_LIFETIME_MS) },
      new Date(start.getTime() + ANONYMOUS_LIFETIME_MS))).toBe(false);
    expect(isSessionValid(session, new Date(start.getTime() - 1))).toBe(false);
    expect(isSessionValid(session, new Date(NaN))).toBe(false);
  });
});

describe('opt-in cleanup task', () => {
  it('does not overlap, uses a bounded batch, and drains during stop', async () => {
    vi.useFakeTimers();
    let release!: (count: number) => void;
    const cleanupExpired = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const stop = startSessionCleanup({ cleanupExpired });
    expect(cleanupExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(cleanupExpired).toHaveBeenCalledExactlyOnceWith(100);
    const stopping = stop();
    release(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cleanupExpired).toHaveBeenCalledTimes(1);
  });
  it('reports a fixed failure message and continues without leaking error contents', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanupExpired = vi.fn().mockRejectedValueOnce(new Error('private-email password postgres://secret')).mockResolvedValue(0);
    const stop = startSessionCleanup({ cleanupExpired });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cleanupExpired).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledExactlyOnceWith('Expired session cleanup failed.');
    } finally { await stop(); log.mockRestore(); }
  });
});
