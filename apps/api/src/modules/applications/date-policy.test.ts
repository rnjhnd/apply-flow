import { describe, expect, it, vi } from 'vitest';
import { createApplicationDatePolicy } from './date-policy.js';

describe('application date policy', () => {
  it('uses Asia/Manila by default and an injected clock', () => {
    const now = vi.fn(() => new Date('2026-10-21T16:00:00.000Z'));
    const policy = createApplicationDatePolicy({ now });
    expect(policy('2026-10-22')).toEqual({ valid: true });
    expect(policy('2026-10-23')).toMatchObject({ valid: false, field: 'applicationDate' });
    expect(now).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['2026-10-21T15:59:59.999Z', 'Asia/Manila', '2026-10-21'],
    ['2026-10-21T16:00:00.000Z', 'Asia/Manila', '2026-10-22'],
    ['2026-10-22T00:00:00.000Z', 'America/Los_Angeles', '2026-10-21'],
    ['2026-03-08T10:00:00.000Z', 'America/Los_Angeles', '2026-03-08'],
    ['2026-10-22T00:00:00.000Z', 'UTC', '2026-10-22']
  ])('computes today for %s in %s', (instant, timeZone, today) => {
    const policy = createApplicationDatePolicy({ now: () => new Date(instant), timeZone });
    expect(policy(today)).toEqual({ valid: true });
    expect(policy('2000-02-29')).toEqual({ valid: true });
    expect(policy('9999-12-31').valid).toBe(false);
  });
  it('does not freeze today at policy creation', () => {
    let instant = '2026-10-21T15:59:59.999Z';
    const policy = createApplicationDatePolicy({ now: () => new Date(instant) });
    expect(policy('2026-10-22').valid).toBe(false);
    instant = '2026-10-21T16:00:00.000Z';
    expect(policy('2026-10-22').valid).toBe(true);
  });
  it.each(['', 'Invalid/Zone', 'Mars/Phobos'])('rejects invalid timezone %j at construction', (timeZone) => {
    expect(() => createApplicationDatePolicy({ now: () => new Date(), timeZone })).toThrow(/APP_TIMEZONE/);
  });
  it('does not read process timezone configuration', () => {
    vi.stubEnv('APP_TIMEZONE', 'Invalid/Zone');
    try { expect(createApplicationDatePolicy({ now: () => new Date('2026-10-21T16:00:00Z') })('2026-10-22').valid).toBe(true); }
    finally { vi.unstubAllEnvs(); }
  });
  it('permits absent saved dates without consulting the clock', () => {
    const now = vi.fn(() => { throw new Error('must not read clock'); });
    expect(createApplicationDatePolicy({ now })(null)).toEqual({ valid: true });
    expect(now).not.toHaveBeenCalled();
  });
  it.each(['2026-02-29', '2026-13-01', '2026-1-1', ''])('rejects structurally invalid date %j without clock access', (date) => {
    const now = vi.fn(() => new Date());
    expect(createApplicationDatePolicy({ now })(date).valid).toBe(false);
    expect(now).not.toHaveBeenCalled();
  });
  it.each([new Date(NaN), new Date('0000-01-01T00:00:00Z'), new Date('+010000-01-01T00:00:00Z')])('fails closed on invalid/out-of-range clocks', (instant) => {
    expect(() => createApplicationDatePolicy({ now: () => instant })('2026-10-22')).toThrow('Invalid application clock.');
  });
});
