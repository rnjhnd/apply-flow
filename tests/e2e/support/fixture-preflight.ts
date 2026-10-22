import { readFileSync, writeSync } from 'node:fs';
import type { Pool, PoolConfig } from 'pg';
import type { Socket } from 'node:net';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';
import { approvedChecksum } from './database-preflight.js';
import { digest } from './schema.js';
import { inspectReadOnlyDatabase, type ReadOnlyDependencies } from './read-only-database.js';
import { inspectFixtureDatabase, type FixtureDriver } from './fixture-database.js';

type Interrupt = 'SIGINT' | 'SIGTERM' | 'SIGBREAK';
// Required injected constructor ports. No installed defaults, token, issuer,
// live connector, or arbitrary transaction/SQL interface is exported.
export type FixtureInspectionRuntime = {
  environment: DatabaseEnvironment;
  args: readonly string[];
  platform: NodeJS.Platform;
  signals: { on(event: Interrupt, handler: () => void): unknown; off(event: Interrupt, handler: () => void): unknown };
  readMigration(): Uint8Array;
  readOnly(): Promise<ReadOnlyDependencies>;
  prisma(): Promise<FixtureDriver>;
  output(line: string): void;
};
const messages = Object.freeze({
  PASSED: 'Sequential read-only inspections, rollbacks and owned resource closure completed.',
  ARGUMENTS: 'This command accepts no arguments.',
  ADMISSION: 'Explicit isolated test environment admission failed.',
  MIGRATION: 'Approved migration bytes could not be verified.',
  B2_FAILED: 'The initial read-only inspection or its shutdown failed.',
  PRISMA_FAILED: 'The read-only Prisma inspection or its shutdown failed.',
  TIMEOUT: 'Inspection dependency loading exceeded its deadline.',
  INTERRUPTED: 'Inspection was interrupted; success is not established.',
  UNEXPECTED: 'Inspection failed; no sensitive diagnostics were emitted.'
});
type Outcome = keyof typeof messages;
function line(code: Outcome) { return `APPLYFLOW_FIXTURE_INSPECTION ${code}: ${messages[code]}`; }

function admit(source: DatabaseEnvironment): string {
  const target = admitEnvironment(source);
  if (Object.keys(source).some((key) => source[key] !== undefined
    && /^(DEBUG|NODE_DEBUG|RUST_LOG|RUST_BACKTRACE|PRISMA_.*LOG.*)$/i.test(key))) throw new Error();
  return target.connectionString;
}

// The capability never leaves this module, even through injected ports. Each
// invocation owns a separate, one-shot allocation budget and abort lifetime.
type Authority = Readonly<object>;
type Grant = { assert(): void; revoked: boolean; poolUsed: boolean; socketUsed: boolean; prismaUsed: boolean; pool?: Pool };
const grants = new WeakMap<Authority, Grant>();
function issue(assert: () => void): Authority {
  assert(); const token = Object.freeze({});
  grants.set(token, { assert, revoked: false, poolUsed: false, socketUsed: false, prismaUsed: false });
  return token;
}
function revoke(token: Authority | undefined) { if (token) { const grant = grants.get(token); if (grant) grant.revoked = true; } }
function active(token: Authority): Grant {
  const grant = grants.get(token);
  if (!grant || grant.revoked) throw new Error();
  try { grant.assert(); } catch { grant.revoked = true; throw new Error(); }
  return grant;
}
type ResourceObservation = { watch(resource: Pool | Socket): void; fail(): void };
function privateDriver(token: Authority, constructors: FixtureDriver, observation: ResourceObservation): FixtureDriver {
  return Object.freeze({
    pool(config: PoolConfig) {
      const grant = active(token);
      // Independent mode check before the constructor. No caller-controlled
      // config is spread into installed pg configuration.
      if (grant.poolUsed || config.host !== '127.0.0.1' || config.port !== 5433
        || config.database !== 'applyflow_test' || config.user !== 'applyflow_test' || config.ssl !== false
        || config.max !== 1 || config.options !== '-c default_transaction_read_only=on -c search_path=pg_catalog,public'
        || typeof config.stream !== 'function' || typeof config.onConnect !== 'function') {
        revoke(token); throw new Error();
      }
      grant.poolUsed = true;
      const stream = config.stream; const onConnect = config.onConnect;
      const pool = constructors.pool({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', user: 'applyflow_test',
        password: config.password, ssl: false, pipeline: false, application_name: 'applyflow-prisma-inspection',
        max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 5000,
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10000,
        options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public',
        stream: () => { active(token); return stream(); },
        onConnect: async (client) => { active(token); await onConnect(client); active(token); }
      });
      // Return ownership even if cancellation raced constructor completion;
      // the connector must be able to close this exact pool on failure.
      grant.pool = pool; observation.watch(pool); return pool;
    },
    socket() {
      const grant = active(token);
      if (!grant.poolUsed || grant.socketUsed) { revoke(token); throw new Error(); }
      grant.socketUsed = true;
      const socket = constructors.socket(); observation.watch(socket); return socket;
    },
    prisma(pool: Pool, error: () => void) {
      const grant = active(token);
      if (pool !== grant.pool || grant.prismaUsed) { revoke(token); throw new Error(); }
      grant.prismaUsed = true;
      const client = constructors.prisma(pool, () => { observation.fail(); error(); });
      // Closure remains available after revocation. The connector owns query
      // admission and still permits necessary ROLLBACK after failure.
      return Object.freeze({
        $connect: () => { active(token); return client.$connect(); },
        $disconnect: () => client.$disconnect(),
        $transaction: ((...args: unknown[]) => { active(token); return Reflect.apply(client.$transaction, client, args); }) as typeof client.$transaction
      });
    }
  });
}

export async function runFixtureInspection(runtime: FixtureInspectionRuntime): Promise<number> {
  const controller = new AbortController();
  const handlers: Array<{ signal: Interrupt; handler: () => void }> = [];
  let interruptedBy: Interrupt | undefined; let authority: Authority | undefined;
  let resourceFailed = false; let prismaClosed = false;
  const resourceListeners: Array<() => void> = [];
  const observation: ResourceObservation = {
    fail() { resourceFailed = true; revoke(authority); },
    watch(resource) {
      // Independent of PrismaPg's listeners, which may be removed by disconnect.
      // Track before registration; do not lose a returned resource if on() fails.
      resourceListeners.push(() => { resource.off('error', observation.fail); });
      try { resource.on('error', observation.fail); } catch { observation.fail(); }
    }
  };
  let outcome: Outcome; let stage: Outcome = 'ARGUMENTS';
  let rejectInterrupted!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = () => reject(new Error()); });
  void interrupted.catch(() => undefined);
  async function load<T>(loader: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([loader(), interrupted, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { stage = 'TIMEOUT'; revoke(authority); reject(new Error()); }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    if (runtime.args.length !== 0) throw new Error();
    stage = 'ADMISSION'; const initial = admit(runtime.environment);
    stage = 'UNEXPECTED';
    const signals: Interrupt[] = runtime.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      const handler = () => {
        if (!controller.signal.aborted) { interruptedBy = signal; revoke(authority); controller.abort(); rejectInterrupted(); }
      };
      handlers.push({ signal, handler }); runtime.signals.on(signal, handler);
    }
    stage = 'MIGRATION'; const migration = Uint8Array.from(runtime.readMigration());
    if (digest(migration) !== approvedChecksum) throw new Error();
    const source = Object.freeze({ NODE_ENV: 'test', TEST_DATABASE_URL: initial });
    const assert = () => {
      if (resourceFailed || controller.signal.aborted || admit(runtime.environment) !== initial || digest(migration) !== approvedChecksum) throw new Error();
    };
    assert(); stage = 'B2_FAILED';
    const b2 = await load(() => runtime.readOnly()); assert();
    // Never race active adapters against cancellation. They retain ownership of
    // bounded rollback/closure until settlement, including after interruption.
    const first = await inspectReadOnlyDatabase(source, migration, b2, controller.signal);
    assert();
    if (first.outcome !== 'passed' || first.readOnly !== true || first.closed !== true) throw new Error();
    authority = issue(assert); stage = 'PRISMA_FAILED';
    const constructors = await load(() => runtime.prisma()); active(authority);
    const driver = privateDriver(authority, constructors, observation);
    const receipt = await inspectFixtureDatabase(source, migration, driver, controller.signal, observation.fail);
    if (receipt.outcome !== 'passed' || receipt.readOnly !== true || receipt.closed !== true) throw new Error();
    prismaClosed = true;
    active(authority);
    outcome = 'PASSED';
  } catch { outcome = controller.signal.aborted ? 'INTERRUPTED' : stage; }
  finally {
    revoke(authority);
    // Remove only our observers, and only with confirmed closure. Failed or
    // unconfirmed shutdown retains sanitized sinks; no new work is admitted.
    if (prismaClosed) {
      for (const remove of resourceListeners) {
        try { remove(); } catch { observation.fail(); }
      }
    }
    // Interruption remains observable throughout owned-observer teardown.
    for (const { signal, handler } of handlers) {
      try { runtime.signals.off(signal, handler); } catch { outcome = 'UNEXPECTED'; }
    }
  }
  // Finite completion boundary: confirmed rollback, observed socket close and
  // owned shutdown, observer/handler teardown, then this synchronous check before
  // the fixed reporter.
  // No await follows. This does not promise observation of arbitrarily late
  // synthetic events on already-closed handles after reporting has begun.
  if (resourceFailed) outcome = 'PRISMA_FAILED';
  if (controller.signal.aborted) outcome = 'INTERRUPTED';
  try { runtime.output(line(outcome)); }
  catch { return 1; }
  return outcome === 'PASSED' ? 0 : outcome === 'INTERRUPTED' ? interruptedBy === 'SIGTERM' ? 143 : 130 : 1;
}

// Node 24's native main bit is the sole entry mechanism. A spoofed argv during
// import cannot create a shell runtime or reach installed constructors.
if (import.meta.main === true) {
  process.exitCode = 1;
  try {
    process.exitCode = await runFixtureInspection({
      environment: process.env, args: process.argv.slice(2), platform: process.platform, signals: process,
      readMigration: () => readFileSync(new URL('../../../apps/api/prisma/migrations/0001_init_auth/migration.sql', import.meta.url)),
      readOnly: async () => {
        const [{ default: net }, { default: pg }] = await Promise.all([import('node:net'), import('pg')]);
        return { socket: () => new net.Socket(), client: (config) => new pg.Client(config) };
      },
      prisma: async () => {
        const [{ default: net }, { default: pg }, { PrismaPg }, { PrismaClient }] = await Promise.all([
          import('node:net'), import('pg'), import('@prisma/adapter-pg'), import('../../../apps/api/src/generated/prisma/client.ts')
        ]);
        return {
          socket: () => new net.Socket(), pool: (config) => new pg.Pool(config),
          prisma: (pool, error) => new PrismaClient({ adapter: new PrismaPg(pool, {
            disposeExternalPool: false, onConnectionError: error, onPoolError: error
          }), log: [] })
        };
      },
      output: (message) => { writeSync(1, `${message}\n`); }
    });
  } catch {
    try { writeSync(2, `${line('UNEXPECTED')}\n`); } catch { /* Never expose raw diagnostics. */ }
    process.exitCode = 1;
  }
}
