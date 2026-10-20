import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('environment configuration', () => {
  it('uses safe development defaults', () => {
    expect(parseEnv({})).toEqual({
      NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, APP_TIMEZONE: 'Asia/Manila'
    });
  });

  it('parses explicit production settings and ignores unrelated process variables', () => {
    expect(parseEnv({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '8080', APP_TIMEZONE: 'UTC', PATH: 'ignored' }))
      .toEqual({ NODE_ENV: 'production', HOST: '0.0.0.0', PORT: 8080, APP_TIMEZONE: 'UTC' });
  });

  it.each(['0', '65536', '-1', '1.5', '', 'abc', '3e3', ' 3000 '])('rejects invalid port %j', (PORT) => {
    expect(() => parseEnv({ PORT })).toThrow(/PORT/);
  });

  it.each(['1', '65535'])('accepts valid boundary port %s', (PORT) => {
    expect(parseEnv({ PORT }).PORT).toBe(Number(PORT));
  });

  it('rejects unsupported environments', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it.each(['', 'Mars/Olympus', '+99:00'])('rejects invalid timezone %j', (APP_TIMEZONE) => {
    expect(() => parseEnv({ APP_TIMEZONE })).toThrow(/APP_TIMEZONE/);
  });

  it('rejects an empty host', () => {
    expect(() => parseEnv({ HOST: ' ' })).toThrow(/HOST/);
  });

  it('does not include unrelated environment values in validation errors', () => {
    expect(() => parseEnv({ PORT: 'invalid', DATABASE_URL: 'private-value' })).not.toThrow(/private-value/);
  });
});
