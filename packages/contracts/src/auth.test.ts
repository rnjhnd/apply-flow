import { describe, expect, it } from 'vitest';
import { authenticatedResponseSchema, authErrorResponseSchema, csrfResponseSchema, loginRequestSchema,
  logoutRequestSchema, normalizedEmailSchema, registerRequestSchema, registrationPasswordSchema } from './auth.js';

describe('authentication contracts', () => {
  it.each([true, false])('requires an explicit boolean registration capability: %s', (registrationEnabled) => {
    const value = { csrfToken: 'a'.repeat(64), registrationEnabled };
    expect(csrfResponseSchema.parse(value)).toEqual(value);
    expect(csrfResponseSchema.safeParse({ ...value, token: 'secret' }).success).toBe(false);
  });
  it.each([undefined, null, 'true', 1])('rejects missing or coerced registration capability: %s', (registrationEnabled) => {
    expect(csrfResponseSchema.safeParse({ csrfToken: 'a'.repeat(64), registrationEnabled }).success).toBe(false);
  });
  it('normalizes email consistently and preserves password bytes', () => {
    expect(registerRequestSchema.parse({ email: '  Student+Jobs@Example.COM ', password: '  A long password  ' }))
      .toEqual({ email: 'student+jobs@example.com', password: '  A long password  ' });
    expect(loginRequestSchema.parse({ email: 'Student+Jobs@Example.COM', password: ' x ' }).password).toBe(' x ');
    expect(normalizedEmailSchema.parse('first.last@example.com')).toBe('first.last@example.com');
  });
  it.each(['bad', 'x@例.com', 'é@example.com', 'a'.repeat(255) + '@example.com', 'a@example.com\nInjected'])('rejects invalid email %j', (email) => {
    expect(normalizedEmailSchema.safeParse(email).success).toBe(false);
  });
  it.each([14, 15, 128, 129])('enforces registration length %i', (length) => {
    expect(registrationPasswordSchema.safeParse('x'.repeat(length)).success).toBe(length >= 15 && length <= 128);
  });
  it('counts Unicode code points and rejects malformed surrogates', () => {
    expect(registrationPasswordSchema.safeParse('😀'.repeat(128)).success).toBe(true);
    expect(registrationPasswordSchema.safeParse('😀'.repeat(129)).success).toBe(false);
    expect(registrationPasswordSchema.safeParse('a'.repeat(15) + '\ud800').success).toBe(false);
    expect(registrationPasswordSchema.safeParse('a'.repeat(15) + '\udc00').success).toBe(false);
    expect(registrationPasswordSchema.parse(' '.repeat(15))).toBe(' '.repeat(15));
  });
  it('rejects empty login passwords and unknown request fields', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ email: 'a@example.com', password: 'x'.repeat(15), userId: 'chosen' }).success).toBe(false);
    expect(logoutRequestSchema.parse(undefined)).toEqual({});
    expect(logoutRequestSchema.safeParse({ sessionId: 'chosen' }).success).toBe(false);
  });
  it('rejects secret-bearing response fields and malformed CSRF tokens', () => {
    const response = { user: { id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', email: 'a@example.com' }, csrfToken: 'a'.repeat(64) };
    expect(authenticatedResponseSchema.parse(response)).toEqual(response);
    expect(authenticatedResponseSchema.safeParse({ ...response, token: 'secret' }).success).toBe(false);
    expect(authenticatedResponseSchema.safeParse({ ...response, user: { ...response.user, passwordHash: 'secret' } }).success).toBe(false);
    expect(csrfResponseSchema.safeParse({ csrfToken: 'a'.repeat(63), registrationEnabled: false }).success).toBe(false);
    expect(authErrorResponseSchema.safeParse({ code: 'INVALID_REQUEST', message: 'Invalid fields.', fieldErrors: { password: ['Too short'] } }).success).toBe(true);
    expect(authErrorResponseSchema.safeParse({ code: 'INVALID_REQUEST', message: 'Invalid fields.', password: 'secret' }).success).toBe(false);
  });
});
