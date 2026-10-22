import { describe, expect, it } from 'vitest';
import { isRegistrationEnabled, parseAuthConfig } from './auth.js';
import { readProductionDatabaseTarget } from './production-database.js';
import { openRuntimeDatabase } from '../db/client.js';

const productionUrl = 'postgresql://runtime:fixture-password@database.example.invalid:5432/applyflow';

describe('authentication configuration', () => {
  it('shares the explicit local/test policy and fails closed even for a misconstructed production config', () => {
    for (const nodeEnv of ['development', 'test', 'production'] as const) {
      for (const allowLocalRegistration of [false, true]) {
        expect(isRegistrationEnabled({ nodeEnv, allowLocalRegistration, appOrigin: 'https://app.example.com' }))
          .toBe(nodeEnv !== 'production' && allowLocalRegistration);
      }
    }
  });
  it('uses explicit local registration and a single local origin', () => {
    expect(parseAuthConfig({})).toEqual({ nodeEnv: 'development', appOrigin: 'http://127.0.0.1:5173', allowLocalRegistration: false });
    expect(parseAuthConfig({ NODE_ENV: 'test', ALLOW_LOCAL_REGISTRATION: 'true' }).allowLocalRegistration).toBe(true);
    expect(parseAuthConfig({ ALLOW_LOCAL_REGISTRATION: 'false' }).allowLocalRegistration).toBe(false);
  });
  it.each(['', '1', 'yes', 'FALSE'])('rejects ambiguous registration flag %j', (ALLOW_LOCAL_REGISTRATION) => {
    expect(() => parseAuthConfig({ ALLOW_LOCAL_REGISTRATION })).toThrow(/configuration/);
  });
  it.each(['https://app.example.com/', 'https://app.example.com/path', 'https://user:secret@app.example.com',
    'https://app.example.com?x=1', 'null', ' https://app.example.com', 'http://app.example.com'])('rejects an unsafe production origin %j', (APP_ORIGIN) => {
    expect(() => parseAuthConfig({ NODE_ENV: 'production', APP_ORIGIN })).toThrow(/APP_ORIGIN/);
  });
  it('requires production origin and forbids production registration', () => {
    expect(() => parseAuthConfig({ NODE_ENV: 'production' })).toThrow(/APP_ORIGIN/);
    expect(() => parseAuthConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://app.example.com', ALLOW_LOCAL_REGISTRATION: 'true' })).toThrow(/registration/);
    expect(parseAuthConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://app.example.com' }).allowLocalRegistration).toBe(false);
  });
  it('does not permit a remote development origin or log a malformed value', () => {
    expect(() => parseAuthConfig({ APP_ORIGIN: 'https://remote.example.com' })).toThrow(/APP_ORIGIN/);
    try { parseAuthConfig({ APP_ORIGIN: 'secret-origin' }); }
    catch (error) { expect((error as Error).message).not.toContain('secret-origin'); }
  });
});

describe('production runtime database configuration, without connections', () => {
  it('requires TLS certificate verification and explicit configured identity', () => {
    expect(readProductionDatabaseTarget({ NODE_ENV: 'production', DATABASE_URL: productionUrl })).toMatchObject({
      database: 'applyflow', username: 'runtime', port: '5432', ssl: { rejectUnauthorized: true }
    });
  });
  it.each([undefined, '', productionUrl + '?sslmode=disable', productionUrl + '?host=other.invalid',
    productionUrl.replace(':5432', ''), productionUrl.replace(':5432', ':65536'), productionUrl + '#fragment',
    productionUrl.replace('fixture-password', ''), productionUrl.replace('fixture-password', '%ZZ')])('rejects an unsafe URL (case %#)', (DATABASE_URL) => {
    expect(() => readProductionDatabaseTarget({ NODE_ENV: 'production', DATABASE_URL })).toThrow(/configuration/);
  });
  it('rejects invalid CA contents without printing them', () => {
    expect(() => readProductionDatabaseTarget({ NODE_ENV: 'production', DATABASE_URL: productionUrl, DATABASE_SSL_CA: 'secret-invalid-certificate' }))
      .toThrow('Invalid production database configuration; require explicit PostgreSQL identity/port, no connection overrides, and a valid optional CA certificate.');
  });
  it('cannot activate production or development runtime connections inside tests', async () => {
    await expect(openRuntimeDatabase({ NODE_ENV: 'production', DATABASE_URL: productionUrl })).rejects.toThrow(/Test processes/);
    await expect(openRuntimeDatabase({ NODE_ENV: 'development' })).rejects.toThrow(/Test processes/);
    await expect(openRuntimeDatabase({ NODE_ENV: 'test', TEST_DATABASE_URL: '' })).rejects.toThrow(/TEST_DATABASE_URL is required/);
  });
});
