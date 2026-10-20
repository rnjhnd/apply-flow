import { describe, expect, it } from 'vitest';
import { assertDatabaseIdentity, readComposePasswords, readDatabaseTarget, requireTestDatabaseTarget } from './database.js';

const devPassword = 'dev-fixture-password-not-a-secret';
const testPassword = 'test-fixture-password-not-a-secret';
const devUrl = `postgresql://applyflow_dev:${devPassword}@127.0.0.1:15432/applyflow_dev`;
const testUrl = `postgresql://applyflow_test:${testPassword}@127.0.0.1:5433/applyflow_test`;
const environment = {
  NODE_ENV: 'development', DATABASE_URL: devUrl, TEST_DATABASE_URL: testUrl,
  POSTGRES_DEV_PASSWORD: devPassword, POSTGRES_TEST_PASSWORD: testPassword
};

describe('local database target safety', () => {
  it('accepts the explicit development target', () => {
    expect(readDatabaseTarget('development', environment)).toMatchObject({
      name: 'development', host: '127.0.0.1', port: '15432', database: 'applyflow_dev', username: 'applyflow_dev'
    });
  });

  it('accepts the dedicated test target with an explicit test environment', () => {
    expect(requireTestDatabaseTarget({ ...environment, NODE_ENV: 'test' }).database).toBe('applyflow_test');
  });

  it('rejects the occupied default development port instead of reaching another PostgreSQL installation', () => {
    expect(() => readDatabaseTarget('development', { ...environment, DATABASE_URL: devUrl.replace(':15432', ':5432') })).toThrow();
  });

  it('accepts localhost and the public schema', () => {
    expect(readDatabaseTarget('test', { ...environment, TEST_DATABASE_URL: testUrl.replace('127.0.0.1', 'localhost') + '?schema=public' }).host).toBe('localhost');
  });

  it('never falls back to DATABASE_URL when TEST_DATABASE_URL is absent', () => {
    expect(() => requireTestDatabaseTarget({ NODE_ENV: 'test', DATABASE_URL: devUrl })).toThrow(/TEST_DATABASE_URL is required/);
  });

  it('refuses development access from a test process', () => {
    expect(() => readDatabaseTarget('development', { ...environment, NODE_ENV: 'test' })).toThrow(/cannot target/);
  });

  it.each(['production', 'staging'])('refuses the %s environment', (NODE_ENV) => {
    expect(() => readDatabaseTarget('test', { ...environment, NODE_ENV })).toThrow(/restricted/);
  });

  it('requires test mode for test-data writes', () => {
    expect(() => requireTestDatabaseTarget(environment)).toThrow(/NODE_ENV=test/);
  });

  it.each([
    '', 'invalid', devUrl,
    testUrl.replace('127.0.0.1', 'database.example.com'),
    testUrl.replace(':5433', ':5432'),
    testUrl.replace(':5433', ''),
    testUrl.replace('/applyflow_test', '/applyflow_dev'),
    testUrl.replace('applyflow_test:', 'postgres:'),
    testUrl.replace('postgresql:', 'https:'),
    testUrl.replace(testPassword, ''),
    testUrl.replace(testPassword, 'replace_with_password'),
    testUrl.replace(testPassword, '%ZZ'),
    testUrl + '?host=database.example.com',
    testUrl + '?options=-c%20search_path%3Dprivate',
    testUrl + '?schema=private',
    testUrl + '?schema=public&schema=public',
    testUrl + '#fragment',
    ' ' + testUrl
  ])('rejects an invalid or ambiguous test URL (case %#)', (TEST_DATABASE_URL) => {
    expect(() => requireTestDatabaseTarget({ ...environment, NODE_ENV: 'test', TEST_DATABASE_URL })).toThrow();
  });

  it('does not disclose a password in an error', () => {
    let message = '';
    try { readDatabaseTarget('test', { ...environment, TEST_DATABASE_URL: testUrl.replace(':5433', ':9999') }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('TEST_DATABASE_URL');
    expect(message).not.toContain(testPassword);
    expect(message).not.toContain('postgresql://');
  });

  it('checks the connected database and user independently of the URL', () => {
    const target = readDatabaseTarget('test', environment);
    expect(() => assertDatabaseIdentity(target, { database: 'applyflow_test', username: 'applyflow_test' })).not.toThrow();
    expect(() => assertDatabaseIdentity(target, { database: 'applyflow_dev', username: 'applyflow_test' })).toThrow();
    expect(() => assertDatabaseIdentity(target, { database: 'applyflow_test', username: 'postgres' })).toThrow();
    expect(() => assertDatabaseIdentity(target, undefined)).toThrow();
  });

  it('accepts matching independent Compose credentials', () => {
    expect(readComposePasswords(environment)).toEqual({ dev: devPassword, test: testPassword });
  });

  it('refuses Compose tooling in production', () => {
    expect(() => readComposePasswords({ ...environment, NODE_ENV: 'production' })).toThrow(/restricted/);
  });

  it.each([
    { POSTGRES_DEV_PASSWORD: undefined },
    { POSTGRES_DEV_PASSWORD: 'short' },
    { POSTGRES_TEST_PASSWORD: devPassword },
    { POSTGRES_TEST_PASSWORD: 'another-test-password' }
  ])('rejects missing, weak, shared, or mismatched Compose credentials (case %#)', (override) => {
    expect(() => readComposePasswords({ ...environment, ...override })).toThrow();
  });
});
