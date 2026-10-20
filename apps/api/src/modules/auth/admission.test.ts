import { describe, expect, it } from 'vitest';
import { AUTH_LIMITS, BoundedRateStore, createAdmissionKeys, createAuthAdmission } from './admission.js';

const key = (letter: string) => letter.repeat(64);
function fixture(maxKeys?: number) {
  let time = 0;
  return { admission: createAuthAdmission({ now: () => new Date(time), ...(maxKeys === undefined ? {} : { maxKeys }) }), advance: (ms: number) => { time += ms; } };
}

describe('bounded authentication counters', () => {
  it.each([0, -1, 5001, 1.5])('rejects invalid capacity %s', (maxKeys) => {
    expect(() => new BoundedRateStore(1000, () => new Date(0), maxKeys)).toThrow(/unavailable/);
  });
  it('fails closed at capacity without evicting active counters; reclaims expired counters at the exact boundary', () => {
    let now = 0;
    const store = new BoundedRateStore(1000, () => new Date(now), 1);
    expect(store.increment(key('a')).totalHits).toBe(1);
    expect(() => store.increment(key('b'))).toThrow(/unavailable/);
    expect(store.get(key('a'))?.totalHits).toBe(1);
    now = 999;
    expect(() => store.increment(key('b'))).toThrow(/unavailable/);
    now = 1000;
    expect(store.increment(key('b')).totalHits).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get(key('a'))).toBeUndefined();
  });
  it('returns copies, never extends a window, and supports decrement/reset without negative counts', () => {
    const store = new BoundedRateStore(1000, () => new Date(0));
    const first = store.increment(key('a'));
    first.resetTime?.setTime(9000);
    expect(store.increment(key('a'))).toEqual({ totalHits: 2, resetTime: new Date(1000) });
    store.decrement(key('a')); store.decrement(key('a')); store.decrement(key('a'));
    expect(store.get(key('a'))?.totalHits).toBe(0);
    store.resetKey(key('a'));
    expect(store.size).toBe(0);
  });
  it('rejects nonopaque keys and invalid clocks without retaining the input', () => {
    const store = new BoundedRateStore(1000, () => new Date(0));
    expect(() => store.increment('private@example.invalid')).toThrow('Authentication admission is unavailable.');
    expect(store.size).toBe(0);
    expect(() => new BoundedRateStore(1000, () => new Date(NaN)).increment(key('a'))).toThrow(/unavailable/);
  });
});

describe('opaque admission identity', () => {
  const keys = createAdmissionKeys(Buffer.alloc(32, 1));
  it('normalizes case/whitespace but preserves email dots and plus suffixes', () => {
    const canonical = keys.emailIp('login', '127.0.0.1', 'Person@Example.invalid');
    expect(keys.emailIp('login', '127.0.0.1', '  PERSON@example.invalid  ')).toBe(canonical);
    expect(keys.emailIp('login', '127.0.0.1', 'per.son@example.invalid')).not.toBe(canonical);
    expect(keys.emailIp('login', '127.0.0.1', 'person+tag@example.invalid')).not.toBe(canonical);
    expect(canonical).toMatch(/^[a-f0-9]{64}$/);
    expect(canonical).not.toContain('person');
  });
  it('canonicalizes IPv4-mapped IPv6 and groups native IPv6 by /56', () => {
    expect(keys.ip('ip', '::ffff:127.0.0.1')).toBe(keys.ip('ip', '127.0.0.1'));
    expect(keys.ip('ip', '2001:db8:1234:5600::1')).toBe(keys.ip('ip', '2001:db8:1234:56ff::2'));
    expect(keys.ip('ip', '2001:db8:1234:5700::1')).not.toBe(keys.ip('ip', '2001:db8:1234:5600::1'));
  });
  it('separates namespaces, IP pairs, and per-process secrets', () => {
    const email = 'private@example.invalid';
    expect(keys.emailIp('login', '127.0.0.1', email)).not.toBe(keys.emailIp('login', '127.0.0.2', email));
    expect(keys.ip('login', '127.0.0.1')).not.toBe(keys.ip('register', '127.0.0.1'));
    expect(keys.global('login')).not.toBe(keys.ip('login', '127.0.0.1'));
    expect(createAdmissionKeys(Buffer.alloc(32, 2)).ip('login', '127.0.0.1')).not.toBe(keys.ip('login', '127.0.0.1'));
  });
  it.each(['', 'raw private@example.invalid', 'a@', 'é@example.invalid'])('rejects invalid email without reflecting it: %s', (email) => {
    expect(() => keys.emailIp('login', '127.0.0.1', email)).toThrow('A valid email address is required.');
  });
  it('rejects invalid IP and short secrets without reflecting their values', () => {
    expect(() => keys.ip('login', 'secret-invalid-ip')).toThrow('Authentication admission is unavailable.');
    expect(() => createAdmissionKeys(Buffer.alloc(1))).toThrow(/unavailable/);
  });
});

describe('atomic authentication admission', () => {
  it('admits exactly 20 concurrent anonymous allocations per IP without an unbounded queue', async () => {
    const { admission } = fixture();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => Promise.resolve().then(() => admission.reserveAnonymous('127.0.0.1'))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(20);
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(5);
    for (const result of failures) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 429, retryAfter: 900 });
  });
  it('enforces the global 500-allocation budget across IPs and resets only at 15 minutes', () => {
    const { admission, advance } = fixture();
    for (let ip = 1; ip <= 25; ip++) for (let hit = 0; hit < 20; hit++) admission.reserveAnonymous(`10.0.0.${ip}`);
    expect(() => admission.reserveAnonymous('10.0.0.26')).toThrow(/Too many/);
    advance(899_999);
    expect(() => admission.reserveAnonymous('10.0.0.26')).toThrow(/Too many/);
    advance(1);
    expect(() => admission.reserveAnonymous('10.0.0.26')).not.toThrow();
  });
  it('does not consume the global quota when an IP quota rejects admission', () => {
    const { admission } = fixture();
    for (let ip = 1; ip <= 25; ip++) {
      for (let hit = 0; hit < 20; hit++) admission.reserveAnonymous(`10.0.0.${ip}`);
      expect(() => admission.reserveAnonymous(`10.0.0.${ip}`)).toThrow(/Too many/);
    }
    expect(() => admission.reserveAnonymous('10.0.0.26')).toThrow(/Too many/);
  });
  it('fails closed at bounded key capacity and does not consume an otherwise available IP quota', () => {
    const { admission, advance } = fixture(1);
    admission.admitLogin('127.0.0.1', 'first@example.invalid');
    expect(() => admission.admitLogin('127.0.0.1', 'second@example.invalid')).toThrow(/unavailable/);
    for (let i = 1; i < 5; i++) admission.admitLogin('127.0.0.1', 'first@example.invalid');
    expect(() => admission.admitLogin('127.0.0.1', 'first@example.invalid')).toThrow(/Too many/);
    advance(900_000);
    expect(() => admission.admitLogin('127.0.0.1', 'second@example.invalid')).not.toThrow();
  });
  it('shares normalized pair quotas under concurrent admission, without locking an email across IPs', async () => {
    const { admission } = fixture();
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() =>
      admission.admitLogin('127.0.0.1', i % 2 ? 'PERSON@example.invalid' : ' person@example.invalid '))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(() => admission.admitLogin('127.0.0.2', 'person@example.invalid')).not.toThrow();
  });
  it('enforces 30 logins/IP even across distinct emails and does not count malformed emails', () => {
    const { admission } = fixture();
    for (let i = 0; i < 40; i++) expect(() => admission.admitLogin('127.0.0.1', 'invalid')).toThrow(/valid email/);
    for (let i = 0; i < AUTH_LIMITS.loginIp; i++) admission.admitLogin('127.0.0.1', `user${i}@example.invalid`);
    expect(() => admission.admitLogin('127.0.0.1', 'another@example.invalid')).toThrow(/Too many/);
  });
  it('does not consume IP budget on denied pair attempts', () => {
    const { admission } = fixture();
    for (let i = 0; i < 5; i++) admission.admitLogin('127.0.0.1', 'person@example.invalid');
    for (let i = 0; i < 40; i++) expect(() => admission.admitLogin('127.0.0.1', 'person@example.invalid')).toThrow(/Too many/);
    for (let i = 0; i < 25; i++) admission.admitLogin('127.0.0.1', `other${i}@example.invalid`);
    expect(() => admission.admitLogin('127.0.0.1', 'last@example.invalid')).toThrow(/Too many/);
  });
  it('limits registration to five/IP/hour; expiration is inclusive and instances are independent', () => {
    const { admission, advance } = fixture();
    for (let i = 0; i < 5; i++) admission.admitRegistration('127.0.0.1');
    expect(() => admission.admitRegistration('127.0.0.1')).toThrow(/Too many/);
    expect(() => fixture().admission.admitRegistration('127.0.0.1')).not.toThrow();
    advance(3_599_999);
    expect(() => admission.admitRegistration('127.0.0.1')).toThrow(/Too many/);
    advance(1);
    expect(() => admission.admitRegistration('127.0.0.1')).not.toThrow();
  });
});
