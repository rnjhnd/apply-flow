// Deterministic in-memory fakes. Never instantiate a driver, process, or server.
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';
import { approvedChecksum, approvedMigration } from './database-preflight.js';
import { expectedSchema } from './schema.js';
import { createGuardedTransactions, type DatabaseInspection, type TransactionHost } from './guarded-database.js';
import { createJournal, type JournalIo } from './journal.js';
import { acquireLease, type LeaseIo } from './safety-io.js';
import { createFinalizer } from './finalization.js';
import { ownedEmail, type OwnershipEvent } from './ownership.js';

export const owner = { runId: '11111111-1111-4111-8111-111111111111', testId: '22222222-2222-4222-8222-222222222222' };
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const email = ownedEmail(owner, 'a');
export const hash = 'a'.repeat(64);
export const env = { NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://applyflow_test:offline-only@127.0.0.1:5433/applyflow_test' };
export const sql = readFileSync(new URL('../../../apps/api/prisma/migrations/0001_init_auth/migration.sql', import.meta.url));
export function inspection(): DatabaseInspection {
  return { identity: { database: 'applyflow_test', username: 'applyflow_test', host: '127.0.0.1', port: 5433 },
    history: [{ migration_name: approvedMigration, checksum: approvedChecksum, finished_at: new Date('2026-10-21T00:00:00Z'),
      rolled_back_at: null, applied_steps_count: 1, logs: null }], schema: structuredClone(expectedSchema) };
}
export function memoryIo(): JournalIo & { contents: string; fail: boolean } {
  return { contents: '', fail: false, read() { return this.contents; }, append(line, exclusive) {
    if (this.fail || (exclusive && this.contents)) throw new Error('Injected durable write failure');
    this.contents += line;
  } };
}
export function leaseIo(): LeaseIo & { entries: Map<string, string> } {
  return { entries: new Map(), claim(key, value) {
    if (this.entries.has(key)) throw new Error('Lease already exists'); this.entries.set(key, value);
  }, read(key) { return this.entries.get(key) ?? ''; }, release(key, value) {
    if (this.entries.get(key) !== value) throw new Error('Wrong lease'); this.entries.delete(key);
  } };
}
export function fakeDatabase() {
  const query = vi.fn().mockResolvedValue([]);
  const execute = vi.fn().mockResolvedValue(0);
  // Only explicitly supplied members may be called by the mocked callback.
  const tx = { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient;
  const stats = { commits: 0, rollbacks: 0 };
  const host: TransactionHost = {
    async $transaction(work) {
      try { const result = await work(tx); stats.commits++; return result; }
      catch (error) { stats.rollbacks++; throw error; }
    }
  };
  const inspect = vi.fn().mockImplementation(async () => inspection());
  const database = createGuardedTransactions(env, sql, host, inspect);
  return { host, tx, query, execute, inspect, stats, database };
}
export function finalizationFixture(events: OwnershipEvent[] = []) {
  const journal = memoryIo(); const ledger = memoryIo(); const leases = leaseIo();
  const writer = createJournal(journal, owner);
  for (const event of events) writer.record(event);
  const child = new EventEmitter(); const lease = acquireLease(leases, owner, 'finalizer');
  const finalizer = createFinalizer(owner, journal, ledger, lease, child);
  return { journal, ledger, leases, writer, child, lease, finalizer,
    exit() { finalizer.quiesce(); finalizer.acceptSeal(writer.sealForHandoff()); child.emit('exit', 0, null); } };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
