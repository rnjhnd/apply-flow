import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import pg from 'pg';
import { PrismaClient } from '../../../apps/api/src/generated/prisma/client.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const unavailable = vi.hoisted(() => vi.fn(() => { throw new Error('Forbidden discovery side effect'); }));
vi.mock('../../../apps/api/src/db/client.js', () => ({
  openLocalDatabase: () => unavailable(), openRuntimeDatabase: () => unavailable()
}));
vi.mock('../../../apps/api/src/generated/prisma/client.ts', async (original) => ({
  ...await original<typeof import('../../../apps/api/src/generated/prisma/client.ts')>(),
  PrismaClient: class {
    constructor() { unavailable(); }
    $connect() { return unavailable(); }
  }
}));

const restore: Array<() => void> = [];
function intercept(target: object, key: string): void {
  let owner: object | null = target;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) owner = Object.getPrototypeOf(owner) as object | null;
  if (!owner || !descriptor || typeof descriptor.value !== 'function') throw new Error('Missing discovery tripwire target.');
  const original = descriptor;
  const patchedOwner = owner;
  // Patch real module objects/prototypes as well as ESM exports. CommonJS callers
  // looking up these properties are covered too; no actual I/O method is invoked.
  Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value as object, {
    apply: () => unavailable(), construct: () => unavailable()
  }) });
  restore.push(() => { Object.defineProperty(patchedOwner, key, original); });
}

beforeEach(() => {
  for (const [module, keys] of [
    [net.Socket.prototype, ['connect']], [net.Server.prototype, ['listen']],
    [net, ['Socket', 'createConnection', 'connect', 'createServer']],
    [tls, ['connect', 'TLSSocket']],
    [http, ['request', 'get', 'ClientRequest', 'createServer']],
    [https, ['request', 'get', 'createServer']],
    [childProcess, ['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execSync', 'execFileSync']],
    [pg.Client.prototype, ['connect', 'query']], [pg.Pool.prototype, ['connect', 'query']],
    [pg, ['Client', 'Pool']]
  ] as const) {
    for (const key of keys) intercept(module, key);
  }
  syncBuiltinESMExports();
  vi.stubGlobal('fetch', () => unavailable());
});
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  syncBuiltinESMExports();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
describe('offline Playwright configuration/discovery', () => {
  it('imports every B1 adapter without constructing database, socket, HTTP, or process dependencies', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('TEST_DATABASE_URL', undefined);
    await Promise.all([
      import('./schema.js'), import('./catalog.js'), import('./guarded-database.js'),
      import('./safety-io.js'), import('./journal.js'), import('./finalization.js'),
      import('./cleanup.js'), import('./child-protocol.js'), import('./composition.js'), import('./execution.js'),
      import('./intent-client.js'), import('./child-runtime.js'), import('./evidence-files.js')
    ]);
    expect(unavailable).not.toHaveBeenCalled();
  });
  it('imports without environment admission, network, databases, or application processes', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('TEST_DATABASE_URL', undefined);
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', undefined);
    const config = (await import('../../../playwright.config.js')).default;
    await import('./fixtures.js');
    expect(unavailable).not.toHaveBeenCalled();
    expect(config.webServer).toBeUndefined(); expect(config.globalSetup).toBeUndefined();
    expect(config.use?.baseURL).toBeUndefined(); expect(config.use?.storageState).toBeUndefined();
    expect(config.use).toMatchObject({ browserName: 'chromium', serviceWorkers: 'block',
      trace: 'off', video: 'off', screenshot: 'off', viewport: { width: 1440, height: 900 } });
    expect(config.workers).toBe(1); expect(config.retries).toBe(0);
    expect(config.testMatch).toBe('**/*.e2e.ts');
    expect(config.projects).toEqual([{ name: 'chromium-desktop' }]);
  });
  it.each([
    ['socket constructor', () => new net.Socket()],
    ['direct TCP', () => net.createConnection({ host: '127.0.0.1', port: 1 })],
    ['TCP alias', () => net.connect({ host: '127.0.0.1', port: 1 })],
    ['socket prototype', () => (Object.create(net.Socket.prototype) as net.Socket).connect(1)],
    ['TLS', () => tls.connect({ host: '127.0.0.1', port: 1 })],
    ['HTTP request', () => http.request('http://127.0.0.1:1')],
    ['HTTP get', () => http.get('http://127.0.0.1:1')],
    ['HTTP client constructor', () => new http.ClientRequest('http://127.0.0.1:1')],
    ['HTTPS request', () => https.request('https://127.0.0.1:1')],
    ['HTTPS get', () => https.get('https://127.0.0.1:1')],
    ['HTTP server constructor', () => http.createServer()],
    ['TCP server constructor', () => net.createServer()],
    ['fetch', () => fetch('http://127.0.0.1:1')]
  ] as const)('intercepts %s before any socket/server work', (_label, attempt) => {
    expect(attempt).toThrow('Forbidden discovery side effect'); expect(unavailable).toHaveBeenCalledOnce();
  });
  it.each(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)(
    'intercepts child_process.%s before starting a real child', (method) => {
      expect(() => Reflect.apply(childProcess[method], childProcess, ['forbidden-offline-command']))
        .toThrow('Forbidden discovery side effect');
      expect(unavailable).toHaveBeenCalledOnce();
    }
  );
  it('also intercepts fresh CommonJS lookups and named builtin imports', async () => {
    const require = createRequire(import.meta.url);
    expect(() => (require('node:child_process') as typeof childProcess).spawnSync('forbidden-offline-command'))
      .toThrow('Forbidden discovery side effect');
    expect(() => (require('node:net') as typeof net).createConnection({ port: 1 })).toThrow('Forbidden discovery side effect');
    expect(() => new (require('pg') as typeof pg).Pool()).toThrow('Forbidden discovery side effect');
    const { request } = await import('node:http');
    expect(() => request('http://127.0.0.1:1')).toThrow('Forbidden discovery side effect');
    expect(unavailable).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['pg client constructor', () => new pg.Client()],
    ['pg pool constructor', () => new pg.Pool()],
    ['pg client connect', () => (Object.create(pg.Client.prototype) as pg.Client).connect()],
    ['pg pool connect', () => (Object.create(pg.Pool.prototype) as pg.Pool).connect()],
    ['pg client query', () => (Object.create(pg.Client.prototype) as pg.Client).query('SELECT 1')],
    ['pg pool query', () => (Object.create(pg.Pool.prototype) as pg.Pool).query('SELECT 1')],
    ['Prisma constructor', () => Reflect.construct(PrismaClient, [])],
    ['Prisma connect', () => (Object.create(PrismaClient.prototype) as InstanceType<typeof PrismaClient>).$connect()]
  ] as const)('intercepts %s without a database instance or connection', (_label, attempt) => {
    expect(attempt).toThrow('Forbidden discovery side effect'); expect(unavailable).toHaveBeenCalledOnce();
  });
});
