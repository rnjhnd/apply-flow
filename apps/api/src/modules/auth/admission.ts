import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type ClientRateLimitInfo, type RateLimitInfo, type Store } from 'express-rate-limit';
import { normalizedEmailSchema } from '@applyflow/contracts';
import { AuthHttpError } from './http-error.js';

const MINUTE = 60_000;
export const AUTH_LIMITS = Object.freeze({ requests: 120, anonymousIp: 20, anonymousGlobal: 500,
  loginIp: 30, loginPair: 5, registrationIp: 5, maxKeys: 5000 });
type Clock = () => Date;
type Counter = { hits: number; reset: number };

function unavailable() { return new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Authentication admission is unavailable.', 1); }
function time(clock: Clock): number {
  const value = clock().getTime();
  if (!Number.isFinite(value)) throw unavailable();
  return value;
}

export class BoundedRateStore implements Store {
  readonly localKeys = true;
  private readonly entries = new Map<string, Counter>();
  constructor(readonly windowMs: number, private readonly clock: Clock, private readonly maxKeys: number = AUTH_LIMITS.maxKeys) {
    if (!Number.isInteger(windowMs) || windowMs < 1 || !Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > AUTH_LIMITS.maxKeys) throw unavailable();
  }
  get size() { return this.entries.size; }
  preview(key: string): Counter {
    if (!/^[a-f0-9]{64}$/.test(key)) throw unavailable();
    const now = time(this.clock);
    const entry = this.entries.get(key);
    if (entry && now < entry.reset) return { ...entry };
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) {
      for (const [candidate, counter] of this.entries) if (now >= counter.reset) this.entries.delete(candidate);
      if (this.entries.size >= this.maxKeys) throw unavailable();
    }
    return { hits: 0, reset: now + this.windowMs };
  }
  increment(key: string): ClientRateLimitInfo {
    const entry = this.preview(key);
    entry.hits = Math.min(entry.hits + 1, Number.MAX_SAFE_INTEGER);
    this.entries.set(key, entry);
    return { totalHits: entry.hits, resetTime: new Date(entry.reset) };
  }
  get(key: string): ClientRateLimitInfo | undefined {
    const entry = this.entries.get(key);
    if (!entry || time(this.clock) >= entry.reset) { this.entries.delete(key); return undefined; }
    return { totalHits: entry.hits, resetTime: new Date(entry.reset) };
  }
  decrement(key: string): void {
    const entry = this.entries.get(key);
    if (entry && time(this.clock) < entry.reset) entry.hits = Math.max(0, entry.hits - 1);
  }
  resetKey(key: string): void { this.entries.delete(key); }
}

export function createAdmissionKeys(secret = randomBytes(32)) {
  if (secret.length !== 32) throw unavailable();
  const digest = (parts: string[]) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
  function ipKey(namespace: string, ip: string) {
    if (!isIP(ip)) throw unavailable();
    return digest([namespace, ipKeyGenerator(ip, 56)]);
  }
  return {
    ip: ipKey,
    global: (namespace: string) => digest([namespace]),
    emailIp(namespace: string, ip: string, email: string) {
      const normalized = normalizedEmailSchema.safeParse(email);
      if (!normalized.success) throw new AuthHttpError(400, 'INVALID_REQUEST', 'A valid email address is required.');
      if (!isIP(ip)) throw unavailable();
      return digest([namespace, ipKeyGenerator(ip, 56), normalized.data]);
    }
  };
}

export function clientAddress(request: Request): string {
  const ip = request.socket.remoteAddress;
  if (!ip || !isIP(ip)) throw unavailable();
  return ip;
}

// Independent per-application stores: no process-global counters or credential values.
export function createAuthAdmission(options: { now?: Clock; maxKeys?: number } = {}) {
  const clock = options.now ?? (() => new Date());
  const keys = createAdmissionKeys();
  const store = (window: number) => new BoundedRateStore(window, clock, options.maxKeys);
  const requests = store(MINUTE);
  const anonymousIp = store(15 * MINUTE);
  const anonymousGlobal = store(15 * MINUTE);
  const loginIp = store(15 * MINUTE);
  const loginPair = store(15 * MINUTE);
  const registrationIp = store(60 * MINUTE);

  function consume(quotas: Array<{ store: BoundedRateStore; key: string; limit: number }>): void {
    // No await between checking all dimensions and reserving them: concurrent requests cannot oversubscribe.
    for (const quota of quotas) {
      const entry = quota.store.preview(quota.key);
      if (entry.hits >= quota.limit) throw new AuthHttpError(429, 'RATE_LIMITED', 'Too many authentication requests.',
        Math.max(1, Math.ceil((entry.reset - time(clock)) / 1000)));
    }
    for (const quota of quotas) quota.store.increment(quota.key);
  }

  const opaqueKey = Symbol('authAdmissionKey');
  type LimitedRequest = Request & { [opaqueKey]: string; authRequestLimit?: RateLimitInfo };
  const limiter = rateLimit({
    windowMs: MINUTE, limit: AUTH_LIMITS.requests, store: requests, passOnStoreError: false,
    legacyHeaders: false, standardHeaders: false, requestPropertyName: 'authRequestLimit',
    keyGenerator: (request) => (request as LimitedRequest)[opaqueKey],
    logger: { error: () => console.error('Authentication admission configuration error.'),
      warn: () => console.error('Authentication admission configuration warning.') },
    handler: (request, _response, next) => {
      const reset = (request as LimitedRequest).authRequestLimit?.resetTime?.getTime() ?? time(clock) + MINUTE;
      next(new AuthHttpError(429, 'RATE_LIMITED', 'Too many authentication requests.', Math.max(1, Math.ceil((reset - time(clock)) / 1000))));
    }
  });
  const requestLimit: RequestHandler = (request, response, next) => {
    // The pinned library's opt-in debug logger prints originalUrl/ip. Give it a sanitized facade,
    // so even DEBUG output cannot expose query/path credentials or raw IPs. Never change routing input.
    const facade = Object.create(request) as LimitedRequest;
    Object.defineProperties(facade, { originalUrl: { value: '/api/v1/auth' }, ip: { value: '[redacted]' },
      [opaqueKey]: { value: keys.ip('request', clientAddress(request)) } });
    void limiter(facade, response, (error?: unknown) => {
      const info = facade.authRequestLimit;
      if (info) {
        response.set({ 'RateLimit-Limit': String(info.limit), 'RateLimit-Remaining': String(info.remaining),
          'RateLimit-Reset': String(Math.max(1, Math.ceil(((info.resetTime?.getTime() ?? time(clock)) - time(clock)) / 1000))),
          'RateLimit-Policy': `${AUTH_LIMITS.requests};w=60` });
      }
      next(error);
    });
  };

  return {
    requestLimit,
    reserveAnonymous(ip: string) {
      consume([{ store: anonymousIp, key: keys.ip('anonymous', ip), limit: AUTH_LIMITS.anonymousIp },
        { store: anonymousGlobal, key: keys.global('anonymous-global'), limit: AUTH_LIMITS.anonymousGlobal }]);
    },
    // Call only after origin, JSON, session and CSRF validation when stage 2B.4 adds credential endpoints.
    admitLogin(ip: string, email: string) {
      const pair = keys.emailIp('login-pair', ip, email);
      consume([{ store: loginIp, key: keys.ip('login', ip), limit: AUTH_LIMITS.loginIp },
        { store: loginPair, key: pair, limit: AUTH_LIMITS.loginPair }]);
    },
    admitRegistration(ip: string) {
      consume([{ store: registrationIp, key: keys.ip('registration', ip), limit: AUTH_LIMITS.registrationIp }]);
    }
  };
}
