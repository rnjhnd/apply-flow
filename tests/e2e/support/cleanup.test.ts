import { describe, expect, it, vi } from 'vitest';
import { cleanupSql, executeCleanup, prismaCleanupRepository, type CleanupRepository, type CleanupSession } from './cleanup.js';
import { createGuardedTransactions } from './guarded-database.js';
import { owner, userId, email, hash, env, sql, finalizationFixture, fakeDatabase, deferred, inspection } from './b1-fakes.js';

async function fixture(empty = false) {
  const f = finalizationFixture(empty ? [] : [{ kind: 'email', value: email }, { kind: 'tokenHash', value: hash }]); f.exit();
  const fake = fakeDatabase();
  const permit = await f.finalizer.finalize(fake.database, async () => [{ id: userId, email }]);
  const rows = { users: empty ? [] : [{ id: userId, email }], sessions: empty ? [] : [{ tokenHash: hash, userId }] as CleanupSession[] };
  const repository = { lock: vi.fn<CleanupRepository['lock']>(async () => structuredClone(rows)),
    deleteSessions: vi.fn<CleanupRepository['deleteSessions']>(async (_tx, matches) => [...matches]),
    deleteUsers: vi.fn<CleanupRepository['deleteUsers']>(async (_tx, matches) => [...matches]),
    verifyAbsent: vi.fn<CleanupRepository['verifyAbsent']>(async () => true) };
  return { ...f, ...fake, permit, rows, repository };
}
describe('B1 exact cleanup execution with injected repositories only', () => {
  it('locks exact targets then deletes sessions before users and verifies after commit', async () => {
    const f = await fixture(); f.stats.commits = 0;
    await executeCleanup(f.permit, f.database, f.repository);
    expect(f.repository.lock).toHaveBeenCalledWith(f.tx, { users: [{ id: userId, email }], hashes: [hash] });
    expect(f.repository.deleteSessions).toHaveBeenCalledWith(f.tx, [{ tokenHash: hash, userId }]);
    expect(f.repository.deleteUsers).toHaveBeenCalledWith(f.tx, [{ id: userId, email }]);
    expect(f.repository.deleteSessions.mock.invocationCallOrder[0]!).toBeLessThan(f.repository.deleteUsers.mock.invocationCallOrder[0]!);
    expect(f.repository.verifyAbsent.mock.invocationCallOrder[0]!).toBeGreaterThan(f.repository.deleteUsers.mock.invocationCallOrder[0]!);
    expect(f.stats).toEqual({ commits: 1, rollbacks: 0 }); expect(f.finalizer.phase()).toBe('cleaned');
    await executeCleanup(f.permit, f.database, f.repository); expect(f.repository.lock).toHaveBeenCalledOnce();
  });
  it('does no database work for an empty finalized ownership set', async () => {
    const f = await fixture(true); const transaction = vi.spyOn(f.host, '$transaction');
    await executeCleanup(f.permit, f.database, f.repository);
    expect(transaction).not.toHaveBeenCalled(); expect(f.repository.lock).not.toHaveBeenCalled();
    expect(f.repository.deleteUsers).not.toHaveBeenCalled(); expect(f.repository.deleteSessions).not.toHaveBeenCalled();
    expect(f.finalizer.phase()).toBe('cleaned');
  });
  it('accepts already absent exact targets without broadening deletion', async () => {
    const f = await fixture(); f.rows.users = []; f.rows.sessions = [];
    await executeCleanup(f.permit, f.database, f.repository);
    expect(f.repository.deleteUsers).not.toHaveBeenCalled(); expect(f.repository.deleteSessions).not.toHaveBeenCalled();
    expect(f.repository.verifyAbsent).toHaveBeenCalledOnce();
  });
  it.each(['unrecorded-session', 'foreign-session-owner', 'email-change', 'duplicate-session', 'duplicate-user', 'unexpected-user'])('rolls back %s before deletion', async (kind) => {
    const f = await fixture();
    if (kind === 'unrecorded-session') f.rows.sessions.push({ tokenHash: 'b'.repeat(64), userId });
    if (kind === 'foreign-session-owner') f.rows.sessions = [{ tokenHash: hash, userId: owner.runId }];
    if (kind === 'email-change') f.rows.users = [{ id: userId, email: 'other@example.invalid' }];
    if (kind === 'duplicate-session') f.rows.sessions.push(f.rows.sessions[0]!);
    if (kind === 'duplicate-user') f.rows.users.push(f.rows.users[0]!);
    if (kind === 'unexpected-user') f.rows.users = [{ id: owner.runId, email }];
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.repository.deleteSessions).not.toHaveBeenCalled(); expect(f.repository.deleteUsers).not.toHaveBeenCalled();
    expect(f.stats.rollbacks).toBe(1); expect(f.finalizer.phase()).toBe('review-required');
  });
  it.each(['session', 'user'])('rolls back an unexpected %s RETURNING count', async (kind) => {
    const f = await fixture();
    f.repository[kind === 'session' ? 'deleteSessions' : 'deleteUsers'].mockResolvedValue([]);
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.stats.rollbacks).toBe(1); expect(f.repository.verifyAbsent).not.toHaveBeenCalled();
  });
  it('demonstrates callback rollback with a staged fake store when a later user deletion fails', async () => {
    const f = await fixture(); let committed = structuredClone(f.rows); let staged = structuredClone(committed);
    const host = { async $transaction<T>(work: Parameters<typeof f.host.$transaction<T>>[0]) {
      staged = structuredClone(committed);
      const result = await work(f.tx); committed = structuredClone(staged); return result;
    } };
    const guarded = createGuardedTransactions(env, sql, host, f.inspect);
    f.repository.deleteSessions.mockImplementation(async () => { staged.sessions = []; return structuredClone(f.rows.sessions); });
    f.repository.deleteUsers.mockImplementation(async () => { staged.users = []; return []; });
    await expect(executeCleanup(f.permit, guarded, f.repository)).rejects.toThrow('review');
    expect(committed).toEqual(f.rows); expect(staged.sessions).toEqual([]);
  });
  it('treats post-commit remnants or failed verification as review-only', async () => {
    for (const failure of ['remnant', 'error']) {
      const f = await fixture();
      if (failure === 'remnant') f.repository.verifyAbsent.mockResolvedValue(false);
      else f.repository.verifyAbsent.mockRejectedValue(new Error('private database details'));
      await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow(/^Cleanup requires review\.$/);
      expect(f.finalizer.phase()).toBe('review-required');
      await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
      expect(f.repository.deleteSessions).toHaveBeenCalledOnce();
    }
  });
  it('does not retry a lost commit result or delete again', async () => {
    const f = await fixture(); const host = { async $transaction<T>(work: Parameters<typeof f.host.$transaction<T>>[0]): Promise<T> {
      await work(f.tx); throw new Error('commit acknowledgment lost');
    } };
    const database = createGuardedTransactions(env, sql, host, f.inspect);
    await expect(executeCleanup(f.permit, database, f.repository)).rejects.toThrow('review');
    await expect(executeCleanup(f.permit, database, f.repository)).rejects.toThrow('review');
    expect(f.repository.deleteSessions).toHaveBeenCalledOnce(); expect(f.ledger.contents).not.toContain('acknowledgment lost');
  });
  it('rejects concurrent cleanup attempts without duplicating writes', async () => {
    const f = await fixture(); const gate = deferred<boolean>(); f.repository.verifyAbsent.mockReturnValue(gate.promise);
    const pending = executeCleanup(f.permit, f.database, f.repository);
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('not admitted');
    gate.resolve(true); await pending; expect(f.repository.deleteUsers).toHaveBeenCalledOnce();
  });
  it('rechecks database admission before cleanup writes', async () => {
    const f = await fixture(); f.inspect.mockResolvedValue({ ...await f.inspect(), identity: { database: 'wrong', username: 'applyflow_test', host: '127.0.0.1', port: 5433 } });
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.repository.lock).not.toHaveBeenCalled();
  });
  it('uses only exact parameterized predicates, relationship guards, and sorted locks', () => {
    expect(cleanupSql.lockUsers([])).toBeUndefined(); expect(cleanupSql.lockSessions({ users: [], hashes: [] })).toBeUndefined();
    expect(cleanupSql.deleteSessions([])).toBeUndefined(); expect(cleanupSql.deleteUsers([])).toBeUndefined();
    const users = [{ id: userId, email }];
    const lock = cleanupSql.lockUsers(users)!; expect(lock.sql).toContain('ORDER BY id FOR UPDATE'); expect(lock.values).toEqual([userId]);
    const sessions = cleanupSql.lockSessions({ users, hashes: [hash] })!;
    expect(sessions.sql).toContain(' OR '); expect(sessions.sql).toContain('ORDER BY "tokenHash" FOR UPDATE');
    const deletion = cleanupSql.deleteUsers(users)!; expect(deletion.sql).toContain('NOT EXISTS'); expect(deletion.values).toEqual([userId, email]);
    const tokens = cleanupSql.deleteSessions([{ tokenHash: hash, userId: null }])!;
    expect(tokens.sql).toContain('IS NOT DISTINCT FROM'); expect(tokens.values).toEqual([hash, null]);
    for (const query of [lock, sessions, deletion, tokens]) expect(query.sql).not.toMatch(/LIKE|prefix|expiresAt|TRUNCATE|DROP/i);
  });
  it('binds the Prisma repository to supplied transaction methods and guards post-commit verification', async () => {
    const f = fakeDatabase(); const repository = prismaCleanupRepository(f.database);
    f.query.mockResolvedValueOnce([{ id: userId, email }]).mockResolvedValueOnce([{ tokenHash: hash, userId }]);
    expect(await repository.lock(f.tx, { users: [{ id: userId, email }], hashes: [hash] })).toEqual({ users: [{ id: userId, email }], sessions: [{ tokenHash: hash, userId }] });
    expect(f.query.mock.calls[0]?.[0].sql).toContain('FROM public."User"');
    expect(f.query.mock.calls[1]?.[0].sql).toContain('FROM public."Session"');
    f.query.mockClear(); expect(await repository.deleteUsers(f.tx, [])).toEqual([]); expect(await repository.deleteSessions(f.tx, [])).toEqual([]);
    expect(f.query).not.toHaveBeenCalled();
    expect(await repository.verifyAbsent({ users: [], hashes: [hash] })).toBe(true);
    expect(f.inspect).toHaveBeenCalledTimes(3);
  });
});

describe('B1 audit corrections: cleanup authority through locks, writes and commit', () => {
  it('rolls back review during lock acquisition without issuing deletion calls', async () => {
    const f = await fixture(); f.stats.commits = 0;
    const entered = deferred(); const lock = deferred<Awaited<ReturnType<CleanupRepository['lock']>>>();
    f.repository.lock.mockImplementation(() => { entered.resolve(); return lock.promise; });
    const pending = executeCleanup(f.permit, f.database, f.repository); const failed = expect(pending).rejects.toThrow('review');
    await entered.promise; f.finalizer.review(); lock.resolve(structuredClone(f.rows)); await failed;
    expect(f.repository.deleteSessions).not.toHaveBeenCalled(); expect(f.repository.deleteUsers).not.toHaveBeenCalled();
    expect(f.repository.verifyAbsent).not.toHaveBeenCalled(); expect(f.stats).toEqual({ commits: 0, rollbacks: 1 });
  });
  it('rolls back evidence loss during lock acquisition even before phase is explicitly invalidated', async () => {
    const f = await fixture(); f.stats.commits = 0;
    f.repository.lock.mockImplementation(async () => { f.lease.release(); return structuredClone(f.rows); });
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.repository.deleteSessions).not.toHaveBeenCalled(); expect(f.stats).toEqual({ commits: 0, rollbacks: 1 });
    expect(f.finalizer.phase()).toBe('review-required');
  });
  it.each(['after-sessions', 'after-users', 'final-inspection'] as const)('rolls back authority loss at %s', async (boundary) => {
    const f = await fixture(); f.stats.commits = 0;
    if (boundary === 'after-sessions') f.repository.deleteSessions.mockImplementation(async (_tx, rows) => { f.finalizer.review(); return [...rows]; });
    else if (boundary === 'after-users') f.repository.deleteUsers.mockImplementation(async (_tx, rows) => { f.finalizer.review(); return [...rows]; });
    else {
      let inspections = 0;
      f.inspect.mockImplementation(async () => {
        if (++inspections === 3) f.finalizer.review();
        return inspection();
      });
    }
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.stats).toEqual({ commits: 0, rollbacks: 1 }); expect(f.repository.deleteSessions).toHaveBeenCalledOnce();
    expect(f.repository.deleteUsers).toHaveBeenCalledTimes(boundary === 'after-sessions' ? 0 : 1);
    expect(f.repository.verifyAbsent).not.toHaveBeenCalled(); expect(f.finalizer.phase()).toBe('review-required');
  });
  it('retains review when invalidation races with an already-started commit, without retry or automatic reconciliation', async () => {
    const f = await fixture(); const started = deferred(); const confirmation = deferred(); let commits = 0;
    const host = { async $transaction<T>(work: Parameters<typeof f.host.$transaction<T>>[0]) {
      const value = await work(f.tx); started.resolve(); await confirmation.promise; commits++; return value;
    } };
    const database = createGuardedTransactions(env, sql, host, f.inspect);
    const pending = executeCleanup(f.permit, database, f.repository); const failure = expect(pending).rejects.toThrow(/^Cleanup requires review\.$/);
    await started.promise; f.finalizer.review(); confirmation.resolve(); await failure;
    expect(commits).toBe(1); expect(f.finalizer.phase()).toBe('review-required'); expect(f.ledger.contents).not.toContain('cleaned');
    expect(f.repository.verifyAbsent).not.toHaveBeenCalled();
    await expect(executeCleanup(f.permit, database, f.repository)).rejects.toThrow('review');
    expect(f.repository.deleteSessions).toHaveBeenCalledOnce(); expect(f.repository.deleteUsers).toHaveBeenCalledOnce();
  });
  it('never records cleaned when authority changes during post-commit verification', async () => {
    const f = await fixture(); f.stats.commits = 0; const entered = deferred(); const verification = deferred<boolean>();
    f.repository.verifyAbsent.mockImplementation(() => { entered.resolve(); return verification.promise; });
    const pending = executeCleanup(f.permit, f.database, f.repository); const failed = expect(pending).rejects.toThrow('review');
    await entered.promise; f.finalizer.review(); verification.resolve(true); await failed;
    expect(f.stats.commits).toBe(1); expect(f.finalizer.phase()).toBe('review-required'); expect(f.ledger.contents).not.toContain('cleaned');
    await expect(executeCleanup(f.permit, f.database, f.repository)).rejects.toThrow('review');
    expect(f.repository.verifyAbsent).toHaveBeenCalledOnce();
  });
});
