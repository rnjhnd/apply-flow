import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import type { ReadOnlyDependencies } from './read-only-database.js';
import { admitEnvironment } from './environment.js';

type Interrupt = 'SIGINT' | 'SIGTERM' | 'SIGBREAK';
export type PreflightRuntime = {
  environment: DatabaseEnvironment;
  args: readonly string[];
  platform: NodeJS.Platform;
  signals: { on(event: Interrupt, handler: () => void): unknown; off(event: Interrupt, handler: () => void): unknown };
  readMigration(): Uint8Array;
  driver(): Promise<ReadOnlyDependencies>;
  output(line: string): void;
};
const messages = Object.freeze({
  PASSED: 'Read-only inspection, rollback and connection closure completed.',
  ARGUMENTS: 'This command accepts no arguments.',
  ADMISSION: 'Explicit isolated test environment admission failed.',
  CONNECT: 'The isolated database connection could not be established.',
  CONNECTION: 'The owned database connection failed.',
  PEER: 'The owned protocol socket did not match the approved endpoint.',
  IDENTITY: 'Connected database or user identity did not match.',
  VERSION: 'The PostgreSQL major version did not match.',
  SETTINGS: 'Required read-only transaction settings were not verified.',
  MIGRATION: 'Approved migration contents or history could not be verified.',
  SCHEMA: 'The approved catalog structure could not be verified.',
  CATALOG: 'Catalog inspection could not be completed.',
  QUIET: 'The isolated database quiet requirement was not verified.',
  QUERY: 'A fixed inspection operation failed.',
  ROLLBACK: 'Explicit rollback could not be confirmed.',
  CLOSE: 'Owned connection shutdown could not be confirmed.',
  TIMEOUT: 'The bounded preflight deadline expired.',
  INTERRUPTED: 'Preflight was interrupted; success is not established.',
  UNEXPECTED: 'Preflight failed unexpectedly; no sensitive diagnostics were emitted.'
});
type Outcome = keyof typeof messages;
function line(code: Outcome) { return `APPLYFLOW_PREFLIGHT ${code}: ${messages[code]}`; }

// Mandatory injected runtime: ordinary imports/tests cannot acquire live defaults.
// The shell composition below is selected only by direct entry-file invocation.
export async function runPreflightCommand(runtime: PreflightRuntime): Promise<number> {
  const controller = new AbortController();
  const installed: Array<{ signal: Interrupt; handler: () => void }> = [];
  let interruptedBy: Interrupt | undefined;
  let outcome: Outcome;
  let fallback: Outcome = 'UNEXPECTED';
  let classify: (error: unknown) => Outcome = () => fallback;
  let rejectInterrupted!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = () => reject(new Error()); });
  void interrupted.catch(() => undefined);
  try {
    fallback = 'ARGUMENTS';
    if (runtime.args.length !== 0) throw new Error();
    fallback = 'ADMISSION'; admitEnvironment(runtime.environment);
    fallback = 'UNEXPECTED';
    const signals: Interrupt[] = runtime.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      const handler = () => {
        if (!controller.signal.aborted) {
          interruptedBy = signal; controller.abort(); rejectInterrupted();
        }
      };
      // Track before registration so partially successful registration is removed.
      // Repeated signals join the one adapter shutdown path.
      installed.push({ signal, handler }); runtime.signals.on(signal, handler);
    }
    const adapter = await Promise.race([import('./read-only-database.js'), interrupted]);
    classify = (error) => {
      if (!(error instanceof adapter.ReadOnlyPreflightError)) return fallback;
      const code: unknown = error.detail ?? error.code;
      return typeof code === 'string' && code !== 'PASSED' && Object.hasOwn(messages, code) ? code as Outcome : 'UNEXPECTED';
    };
    if (controller.signal.aborted) throw new Error();
    fallback = 'MIGRATION'; const migration = runtime.readMigration();
    fallback = 'UNEXPECTED';
    if (controller.signal.aborted) throw new Error();
    const database = await Promise.race([runtime.driver(), interrupted]);
    if (controller.signal.aborted) throw new Error();
    // Never abandon this promise on signals. The adapter owns bounded rollback
    // and closure; report only after its shutdown path has settled.
    await adapter.inspectReadOnlyDatabase(runtime.environment, migration, database, controller.signal);
    outcome = controller.signal.aborted ? 'INTERRUPTED' : 'PASSED';
  } catch (error) {
    try { outcome = controller.signal.aborted ? 'INTERRUPTED' : classify(error); }
    catch { outcome = 'UNEXPECTED'; }
  } finally {
    for (const { signal, handler } of installed) {
      try { runtime.signals.off(signal, handler); } catch { outcome = 'UNEXPECTED'; }
    }
  }
  if (controller.signal.aborted) outcome = 'INTERRUPTED';
  try { runtime.output(line(outcome)); }
  catch {
    try { runtime.output(line('UNEXPECTED')); } catch { /* No raw fallback output. */ }
    return 1;
  }
  return outcome === 'PASSED' ? 0 : outcome === 'INTERRUPTED' ? interruptedBy === 'SIGTERM' ? 143 : 130 : 1;
}

export function isPreflightEntrypoint(entry: string | undefined): boolean {
  return !!entry && resolve(entry) === fileURLToPath(import.meta.url);
}

// No general live-phase gate is opened. Only exact direct invocation creates a
// shell runtime, which admits its environment before loading the real driver.
if (isPreflightEntrypoint(process.argv[1])) {
  try {
    process.exitCode = await runPreflightCommand({
      environment: process.env, args: process.argv.slice(2), platform: process.platform, signals: process,
      readMigration: () => readFileSync(new URL('../../../apps/api/prisma/migrations/0001_init_auth/migration.sql', import.meta.url)),
      driver: async () => {
        const [{ default: net }, { default: pg }] = await Promise.all([import('node:net'), import('pg')]);
        return { socket: () => new net.Socket(), client: (config) => new pg.Client(config) };
      },
      // Synchronous bounded-size output makes broken-pipe errors catchable here
      // rather than emitting an asynchronous stdout error with a default stack.
      output: (message) => { writeSync(1, `${message}\n`); }
    });
  } catch {
    try { writeSync(2, `${line('UNEXPECTED')}\n`); } catch { /* Avoid default exception diagnostics. */ }
    process.exitCode = 1;
  }
}
