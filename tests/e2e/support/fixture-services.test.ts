import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma, Session } from '../../../apps/api/src/generated/prisma/client.ts';
import { createPasswordService, ARGON2_PARAMETERS } from '../../../apps/api/src/modules/auth/passwords.js';
import { createGuardedTransactions } from './guarded-database.js';
import { createChildRecorder } from './child-protocol.js';
import { createOperationLedger, readOperationLedger } from './fixture-evidence.js';
import { runServiceFixture, recordedUsers } from './fixture-services.js';
import { env, sql, owner, email, userId, hash, inspection, memoryIo } from './b1-fakes.js';

function fixture() {
  const journal = memoryIo(); const operations = memoryIo(); const review = vi.fn();
  const recorder = createChildRecorder(owner, journal, async () => undefined, review);
  const ledger = createOperationLedger(owner, operations, journal, review);
  const users = new Map<string, { id: string; email: string }>(); const sessions = new Map<string, Session>();
  const stats = { commits: 0, rollbacks: 0, ambiguous: false, receiptFail: false };
  const tx = {
    user: { findUnique: vi.fn(async () => users.get(email) ?? null),
      create: vi.fn(async () => { const created = { id: userId, email }; users.set(email, created); return created; }) },
    session: {
      create: vi.fn(async ({ data }: { data: Omit<Session, 'id'> }) => { const row = { ...data, id: randomUUID() }; sessions.set(row.tokenHash, row); return row; }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = [...sessions.values()].find((row) => row.id === where.id)!; sessions.delete(row.tokenHash); return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => sessions.get(where.tokenHash) ?? null),
      count: vi.fn(async () => [...sessions.values()].filter((row) => row.userId === userId).length)
    },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray, ...parameters: unknown[]) => {
      const text = 'text' in query ? query.text : query.join('');
      const values = 'values' in query && !Array.isArray(query) ? (query as Prisma.Sql).values : parameters;
      if (text.includes('FROM public."Session"')) { const row = sessions.get(values[0] as string); return row ? [row] : []; }
      return [];
    })
  } as unknown as Prisma.TransactionClient;
  const database = createGuardedTransactions(env, sql, {
    async $transaction(work) {
      const backupUsers = new Map(users); const backupSessions = new Map(sessions);
      let result;
      try { result = await work(tx); stats.commits++; }
      catch (error) {
        stats.rollbacks++; users.clear(); sessions.clear();
        for (const pair of backupUsers) users.set(...pair); for (const pair of backupSessions) sessions.set(...pair);
        throw error;
      }
      if (stats.ambiguous && users.size) throw new Error('raw database URL password sentinel');
      if (stats.receiptFail && users.size) operations.fail = true;
      return result;
    }
  }, async () => inspection());
  const backend = { hash: vi.fn(async () => 'fake-hash-only'), verify: vi.fn(async () => true) };
  const passwords = () => createPasswordService(backend);
  const deps = { passwords, now: () => new Date('2026-10-21T00:00:00Z'), id: randomUUID, password: () => '  password combining e\u0301 exact  ' };
  const intent = () => recorder.intent({ type: 'email-intent', ...owner, messageId: randomUUID(), email });
  return { journal, operations, review, recorder, ledger, tx, stats, users, sessions, backend, intent,
    run: () => runServiceFixture(email, database, recorder, ledger, deps) };
}
describe('B3 service-only cycle and durable ownership with staged in-memory rollback', () => {
  it('uses existing hash/session/registration paths and records UUID before commit without leaking responses', async () => {
    const f = fixture(); await f.intent(); expect(await f.run()).toEqual({ usersCreated: 1, sessionsCreated: 2, rotations: 1 });
    expect(f.users.size).toBe(1); expect(f.sessions.size).toBe(1);
    expect([...f.sessions.values()][0]?.userId).toBe(userId); expect(f.stats).toMatchObject({ commits: 3, rollbacks: 0 });
    expect(f.backend.hash).toHaveBeenLastCalledWith('  password combining e\u0301 exact  ', expect.objectContaining(ARGON2_PARAMETERS));
    expect(f.ledger.snapshot().settled).toBe(true); expect(f.recorder.state()).toBe('recording');
    expect(f.operations.contents).toContain('observed-before-commit'); expect(f.operations.contents).toContain('confirmed-commit');
    expect(f.operations.contents + f.journal.contents).not.toContain('password combining');
    expect(f.operations.contents + f.journal.contents).not.toContain('fake-hash-only');
    for (const row of f.sessions.values()) expect(f.operations.contents + f.journal.contents).not.toContain(row.csrfToken);
  });
  it('refuses an unacknowledged intent before password work', async () => {
    const f = fixture(); await expect(f.run()).rejects.toThrow('Acknowledged'); expect(f.backend.hash).not.toHaveBeenCalled();
  });
  it('refuses a pre-existing account and never records/adopts its UUID', async () => {
    const f = fixture(); await f.intent(); f.users.set(email, { id: userId, email });
    await expect(f.run()).rejects.toThrow('review'); expect(f.users.get(email)?.id).toBe(userId);
    expect(f.journal.contents).not.toContain('"kind":"user"'); expect(f.recorder.state()).toBe('review');
  });
  it('rolls back a registration if pre-commit ownership persistence fails', async () => {
    const f = fixture(); await f.intent();
    const original = f.recorder.record;
    vi.spyOn(f.recorder, 'record').mockImplementation((event) => { if (event.kind === 'user') throw new Error('secret'); original(event); });
    await expect(f.run()).rejects.toThrow('review'); expect(f.users.size).toBe(0); expect(f.sessions.size).toBe(1);
    expect(f.stats.rollbacks).toBe(1); expect(f.recorder.state()).toBe('review');
  });
  it('refuses session insertion when token journaling fails', async () => {
    const f = fixture(); await f.intent(); f.journal.fail = true;
    await expect(f.run()).rejects.toThrow('review'); expect(f.sessions.size).toBe(0); expect(f.stats.rollbacks).toBe(1);
  });
  it('retains pre-commit ownership but never claims settlement after an ambiguous commit', async () => {
    const f = fixture(); await f.intent(); f.stats.ambiguous = true;
    await expect(f.run()).rejects.toThrow('review'); expect(f.users.size).toBe(1);
    expect(f.journal.contents).toContain(userId); expect(f.operations.contents).toContain('uncertain-outcome');
    expect(() => f.ledger.assertSettled()).toThrow('review'); expect(f.recorder.state()).toBe('review');
    expect(f.operations.contents).not.toContain('raw database URL');
  });
  it('fails after confirmed commit if the operation receipt cannot be persisted', async () => {
    const f = fixture(); await f.intent(); f.stats.receiptFail = true;
    await expect(f.run()).rejects.toThrow('review'); expect(f.users.size).toBe(1); expect(f.journal.contents).toContain(userId);
  });
  it('detects incorrect rotation/read-back rather than publishing a successful cycle', async () => {
    const f = fixture(); await f.intent(); vi.mocked(f.tx.session.count).mockResolvedValueOnce(2);
    await expect(f.run()).rejects.toThrow('review'); expect(f.recorder.state()).toBe('review');
  });
  it.each(['intent-only', 'wrong-id', 'wrong-email', 'duplicate'])('never resolves unproven ownership: %s', async (kind) => {
    const f = fixture(); await f.intent(); if (kind !== 'intent-only') f.recorder.record({ kind: 'user', value: userId, email });
    const row = { id: kind === 'wrong-id' ? randomUUID() : userId, email: kind === 'wrong-email' ? 'other@example.invalid' : email };
    expect(() => recordedUsers(owner, f.journal, [email], kind === 'duplicate' ? [row, row] : [row])).toThrow();
  });
  it('accepts only exact canonical recorded pairs, with missing rows remaining empty', async () => {
    const f = fixture(); await f.intent(); f.recorder.record({ kind: 'user', value: userId, email });
    expect(recordedUsers(owner, f.journal, [email], [{ id: userId.toUpperCase(), email }])).toEqual([{ id: userId, email }]);
    expect(recordedUsers(owner, f.journal, [email], [])).toEqual([]);
  });
});

describe('B3 allowlisted operation evidence', () => {
  function evidence() {
    const f = fixture(); const id = randomUUID(); f.recorder.record({ kind: 'tokenHash', value: hash });
    f.ledger.start(id, 'anonymous'); return { ...f, id };
  }
  it.each(['extra', 'malformed', 'missing-hash', 'wrong-user'])('rejects unsafe observation %s', (kind) => {
    const f = evidence(); const value = kind === 'wrong-user' ? { kind: 'user', id: userId, email }
      : { kind: 'session', id: kind === 'malformed' ? 'bad' : userId, tokenHash: kind === 'missing-hash' ? 'b'.repeat(64) : hash, userId: null,
        ...(kind === 'extra' ? { databaseUrl: 'secret-sentinel' } : {}) };
    expect(() => f.ledger.observe(f.id, 'anonymous', value as Parameters<typeof f.ledger.observe>[2])).toThrow('review');
    expect(f.operations.contents).not.toContain('secret-sentinel');
  });
  it.each(['digest', 'sequence', 'owner', 'truncate'])('rejects corrupt persisted evidence: %s', (kind) => {
    const f = evidence();
    if (kind === 'digest') f.operations.contents = f.operations.contents.replace('"previousDigest":null', `"previousDigest":"${hash}"`);
    if (kind === 'sequence') f.operations.contents = f.operations.contents.replace('"sequence":0', '"sequence":1');
    if (kind === 'owner') f.operations.contents = f.operations.contents.replace(owner.runId, randomUUID());
    if (kind === 'truncate') f.operations.contents = f.operations.contents.trimEnd();
    expect(() => readOperationLedger(owner, f.operations, f.journal)).toThrow('review');
  });
  it('does not allow duplicate starts, terminal reopening or a confirmed commit without observation', () => {
    for (const kind of ['start', 'commit']) {
      const f = evidence(); expect(() => kind === 'start' ? f.ledger.start(f.id, 'anonymous') : f.ledger.committed(f.id, 'anonymous')).toThrow('review');
      expect(() => f.ledger.start(randomUUID(), 'anonymous')).toThrow('review');
    }
  });
});
