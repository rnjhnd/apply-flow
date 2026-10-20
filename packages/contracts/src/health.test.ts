import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('health response contract', () => {
  it('accepts the documented liveness response', () => {
    const payload = { status: 'ok', service: 'applyflow-api' };
    expect(healthResponseSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    null,
    {},
    { status: 'ok' },
    { status: 'down', service: 'applyflow-api' },
    { status: 'ok', service: 'another-api' },
    { status: 'ok', service: 'applyflow-api', secret: 'unexpected' }
  ])('rejects malformed or unexpected payloads: %j', (payload) => {
    expect(healthResponseSchema.safeParse(payload).success).toBe(false);
  });
});
