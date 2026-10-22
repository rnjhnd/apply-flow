import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChildRecorder } from './child-protocol.js';
import { composeParent, composeServices } from './composition.js';
import { createJournal, readJournalSnapshot } from './journal.js';
import { acquireLease } from './safety-io.js';
import { recordingTokenFactory } from './ownership.js';
import { AuthHttpError } from '../../../apps/api/src/modules/auth/http-error.js';
import type { AuthenticationService } from '../../../apps/api/src/modules/auth/authentication.js';
import { owner, email, hash, userId, memoryIo, leaseIo, fakeDatabase, deferred } from './b1-fakes.js';

const intent = { type: 'email-intent', ...owner, messageId: '33333333-3333-4333-8333-333333333333', email };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('B1 durable child intent and quiescence protocol', () => {
  function fixture() {
    const io = memoryIo(); const send = vi.fn(async () => undefined); const review = vi.fn();
    return { io, send, review, child: createChildRecorder(owner, io, send, review) };
  }
  it('records before acknowledgment; exact duplicate messages do not append twice', async () => {
    const f = fixture();
    f.send.mockImplementation(async () => { expect(readJournalSnapshot(f.io, owner).journal.events).toEqual([{ kind: 'email', value: email }]); });
    expect(() => f.child.assertIntent(email)).toThrow('Acknowledged');
    await f.child.intent(intent); f.child.assertIntent(email);
    const contents = f.io.contents; await f.child.intent(intent);
    expect(f.io.contents).toBe(contents); expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0]).toEqual(f.send.mock.calls[1]); expect(f.review).not.toHaveBeenCalled();
  });
  it.each(['wrong-owner', 'missing-email', 'conflicting-message', 'duplicate-email'])('rejects %s intent', async (kind) => {
    const f = fixture();
    if (kind === 'conflicting-message' || kind === 'duplicate-email') await f.child.intent(intent);
    const bad = kind === 'wrong-owner' ? { ...intent, runId: userId }
      : kind === 'missing-email' ? { ...intent, email: undefined }
      : kind === 'conflicting-message' ? { ...intent, email: email.replace('-a@', '-b@') } : { ...intent, messageId: userId };
    await expect(f.child.intent(bad)).rejects.toThrow('review'); expect(f.child.state()).toBe('review');
    expect(() => f.child.assertIntent(email)).toThrow();
  });
  it.each(['sync', 'async'])('requires review after %s acknowledgment failure', async (kind) => {
    const f = fixture(); f.send.mockImplementation(() => { if (kind === 'sync') throw new Error('channel secret'); return Promise.reject(new Error('channel secret')); });
    await expect(f.child.intent(intent)).rejects.toThrow(/^Fixture acknowledgment requires review\.$/);
    expect(f.child.state()).toBe('review'); expect(() => f.child.assertIntent(email)).toThrow();
    expect(readJournalSnapshot(f.io, owner).journal.events).toEqual([{ kind: 'email', value: email }]);
    expect(f.io.contents).not.toContain('channel secret');
  });
  it('rejects journal append/fsync failure before returning a token or inserting a session', async () => {
    const f = fixture(); const database = fakeDatabase(); const insert = vi.fn();
    Object.assign(database.tx, { session: { create: insert } });
    const authentication = {} as AuthenticationService;
    const services = composeServices(database.database, f.child, () => authentication, () => new Date());
    f.io.fail = true;
    await expect(services.sessions.createAnonymous()).rejects.toThrow('review');
    expect(insert).not.toHaveBeenCalled(); expect(database.stats.rollbacks).toBe(1); expect(f.child.state()).toBe('review');
  });
  it('also refuses asynchronous token-recording sinks without handing off a token', () => {
    const factory = recordingTokenFactory((() => Promise.resolve()) as unknown as Parameters<typeof recordingTokenFactory>[0]);
    expect(factory).toThrow('synchronously');
  });
  it('waits for admitted work and database close before sealing; rejects new work immediately', async () => {
    const f = fixture(); const work = deferred(); const close = deferred(); const closeDatabase = vi.fn(() => close.promise);
    const request = f.child.request(() => work.promise);
    const sealing = f.child.seal(closeDatabase);
    expect(f.child.state()).toBe('quiescing'); await expect(f.child.request(async () => undefined)).rejects.toThrow('closed');
    await expect(f.child.intent(intent)).rejects.toThrow('not admitted'); expect(closeDatabase).not.toHaveBeenCalled();
    // Existing admitted work may finish recording before its own transaction.
    f.child.record({ kind: 'tokenHash', value: hash });
    work.resolve(); await request; await Promise.resolve();
    expect(closeDatabase).toHaveBeenCalledOnce(); expect(f.child.state()).toBe('quiescing');
    close.resolve(); const seal = await sealing;
    expect(seal).toEqual(expect.objectContaining({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(f.child.state()).toBe('sealed'); expect(() => f.child.record({ kind: 'tokenHash', value: 'b'.repeat(64) })).toThrow('closed');
    await expect(f.child.seal(closeDatabase)).rejects.toThrow('not admitted');
  });
  it('never seals an unresolved request merely because shutdown was requested', async () => {
    const f = fixture(); const work = deferred(); const request = f.child.request(() => work.promise); const close = vi.fn();
    const sealing = f.child.seal(close); await Promise.resolve(); expect(close).not.toHaveBeenCalled();
    work.reject(new Error('ambiguous database outcome')); await expect(request).rejects.toThrow('ambiguous');
    await expect(sealing).rejects.toThrow('review'); expect(f.child.state()).toBe('review');
  });
  it('distinguishes settled authentication rejections from uncertain storage outcomes', async () => {
    const f = fixture(); await expect(f.child.request(async () => { throw new AuthHttpError(401, 'INVALID_CREDENTIALS', 'Invalid'); })).rejects.toThrow('Invalid');
    expect(f.child.state()).toBe('recording');
    await f.child.seal(async () => undefined); expect(f.child.state()).toBe('sealed');
    const other = fixture(); await expect(other.child.request(async () => { throw new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Unavailable'); })).rejects.toThrow();
    expect(other.child.state()).toBe('review');
  });
  it('requires review when a queued intent races quiescence or closing the database fails', async () => {
    const f = fixture(); const intentRequest = f.child.intent(intent); const sealing = f.child.seal(async () => undefined);
    await expect(intentRequest).rejects.toThrow('review'); await expect(sealing).rejects.toThrow('review');
    const other = fixture(); await expect(other.child.seal(async () => { throw new Error('close failed'); })).rejects.toThrow('review');
    expect(other.child.state()).toBe('review');
  });
  it('requires acknowledged registration intents and uses one recording token source for authentication and bootstrap', async () => {
    const f = fixture(); const database = fakeDatabase();
    const register = vi.fn<AuthenticationService['register']>();
    const factory = vi.fn((token: () => string) => {
      expect(token()).toMatch(/^[a-f0-9]{64}$/);
      return { register } as unknown as AuthenticationService;
    });
    const services = composeServices(database.database, f.child, factory, () => new Date('2026-10-21T00:00:00Z'));
    expect(() => services.authentication.register({ email, password: 'unlogged password' }, { token: '', csrfToken: '' })).toThrow('Acknowledged');
    expect(register).not.toHaveBeenCalled(); await f.child.intent(intent);
    await services.authentication.register({ email, password: 'unlogged password' }, { token: '', csrfToken: '' });
    expect(register).toHaveBeenCalledOnce(); expect(f.io.contents).not.toContain('unlogged password');
    const create = vi.fn(async ({ data }) => ({ id: userId, ...data })); Object.assign(database.tx, { session: { create } });
    await services.sessions.createAnonymous();
    expect(create).toHaveBeenCalledOnce(); expect(database.stats.commits).toBe(1);
    const stored = readJournalSnapshot(f.io, owner).journal.events;
    expect(stored.filter((event) => event.kind === 'tokenHash')).toHaveLength(3);
    expect(stored).toContainEqual({ kind: 'tokenHash', value: create.mock.calls[0]?.[0].data.tokenHash });
    expect('cleanupExpired' in services.sessions).toBe(false);
  });
});

describe('B1 injected parent lifecycle composition', () => {
  function fixture(sendMode: 'healthy' | 'sync-failure' | 'async-failure' = 'healthy') {
    const journal = memoryIo(); const ledger = memoryIo(); const writer = createJournal(journal, owner);
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn((_message, callback: (error: Error | null) => void) => {
        if (sendMode === 'sync-failure') throw new Error('private send detail');
        if (sendMode === 'async-failure') queueMicrotask(() => callback(new Error('private send detail')));
        else callback(null);
      }), kill: vi.fn()
    });
    const lease = acquireLease(leaseIo(), owner, 'finalizer'); const spawn = vi.fn(() => child);
    const parent = composeParent(owner, journal, ledger, lease, spawn, { startupMs: 100, graceMs: 10, exitMs: 10 });
    return { journal, ledger, writer, child, lease, spawn, parent };
  }
  it('receives a dynamic loopback origin and shares tracked shutdown without claiming early exit', async () => {
    const f = fixture(); f.child.emit('message', { type: 'ready', runId: owner.runId, host: '127.0.0.1', port: 49123 });
    expect(await f.parent.ready).toEqual({ origin: 'http://127.0.0.1:49123' }); expect(f.spawn).toHaveBeenCalledOnce();
    const stopping = f.parent.stop(); expect(f.parent.isHealthy()).toBe(false); expect(f.parent.stop()).toBe(stopping);
    await Promise.resolve(); const seal = f.writer.sealForHandoff();
    f.child.emit('message', { type: 'child-sealed', ...owner, sequence: seal.sequence, digest: seal.digest });
    expect(f.parent.finalizer.phase()).toBe('child-sealed'); f.child.emit('exit', 0, null); await stopping;
    expect(f.parent.finalizer.phase()).toBe('exit-confirmed'); expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.child.listenerCount('message')).toBe(0); expect(f.child.listenerCount('exit')).toBe(0);
  });
  it.each(['sync-failure', 'async-failure'] as const)('fails closed on %s shutdown IPC', async (mode) => {
    vi.useFakeTimers(); const f = fixture(mode); const ready = f.parent.ready.catch(() => undefined);
    const stopping = f.parent.stop(); await Promise.resolve(); await Promise.resolve();
    expect(f.parent.finalizer.phase()).toBe('review-required'); f.child.emit('exit', 0, null);
    await stopping; await ready; expect(f.child.send).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it('escalates only the owned handle and never authorizes cleanup on ambiguous termination', async () => {
    vi.useFakeTimers(); const f = fixture(); const ready = f.parent.ready.catch(() => undefined);
    const stopping = f.parent.stop(); const failure = expect(stopping).rejects.toThrow('exit unconfirmed');
    await vi.advanceTimersByTimeAsync(25); await failure; await ready;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.parent.finalizer.phase()).toBe('review-required');
    expect(f.child.send).toHaveBeenCalledOnce(); f.child.emit('exit', 0, null);
  });
  it('still stops its owned child when durable quiescing evidence fails', async () => {
    const f = fixture(); const ready = f.parent.ready.catch(() => undefined); f.ledger.fail = true;
    const stopping = f.parent.stop(); await Promise.resolve(); f.child.emit('exit', 0, null);
    await stopping; await ready; expect(f.parent.finalizer.phase()).toBe('review-required'); expect(f.child.send).toHaveBeenCalledOnce();
  });
  it('rejects bad admission before invoking spawn and records a spawn failure for review', () => {
    const journal = memoryIo(); const ledger = memoryIo(); const lease = acquireLease(leaseIo(), owner, 'finalizer'); const spawn = vi.fn();
    expect(() => composeParent(owner, journal, ledger, lease, spawn)).toThrow(); expect(spawn).not.toHaveBeenCalled();
    createJournal(journal, owner); spawn.mockImplementation(() => { throw new Error('private spawn detail'); });
    expect(() => composeParent(owner, journal, ledger, lease, spawn)).toThrow(/^Owned child creation requires review\.$/);
    expect(ledger.contents).toContain('review-required'); expect(ledger.contents).not.toContain('private spawn detail');
  });
  it('accepts controlled closure only after a validated seal and normal parent-observed exit', async () => {
    const f = fixture(); f.child.emit('message', { type: 'ready', runId: owner.runId, host: '127.0.0.1', port: 49123 });
    await f.parent.ready; const stopping = f.parent.stop(); expect(f.parent.stop()).toBe(stopping); expect(f.parent.isHealthy()).toBe(false);
    await Promise.resolve(); const seal = f.writer.sealForHandoff();
    f.child.emit('message', { type: 'child-sealed', ...owner, sequence: seal.sequence, digest: seal.digest });
    f.child.emit('message', { type: 'channel-closing', ...owner });
    f.child.emit('disconnect'); f.child.emit('disconnect');
    expect(f.parent.finalizer.phase()).toBe('child-sealed');
    await expect(f.parent.finalizer.finalize(fakeDatabase().database)).rejects.toThrow('not admitted');
    f.child.emit('exit', 0, null); await stopping;
    expect(f.parent.finalizer.phase()).toBe('exit-confirmed'); await f.parent.finalizer.finalize(fakeDatabase().database);
    expect(f.parent.finalizer.phase()).toBe('cleanup-eligible'); expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.child.send).toHaveBeenCalledOnce(); expect(f.child.listenerCount('message')).toBe(0);
  });
  it.each(['before-seal', 'wrong-owner', 'bad-seal', 'unexpected-fields'] as const)(
    'rejects %s closure IPC without treating a later zero exit as recovery', async (failure) => {
      const f = fixture(); const ready = f.parent.ready.catch(() => undefined); const stopping = f.parent.stop();
      await Promise.resolve(); const seal = f.writer.sealForHandoff();
      if (failure !== 'before-seal') f.child.emit('message', { type: 'child-sealed', ...owner,
        sequence: seal.sequence, digest: failure === 'bad-seal' ? hash : seal.digest });
      const closing = { type: 'channel-closing', ...owner, ...(failure === 'wrong-owner' ? { testId: userId } : {}),
        ...(failure === 'unexpected-fields' ? { cookie: 'private-sentinel' } : {}) };
      f.child.emit('message', closing); f.child.emit('disconnect'); f.child.emit('exit', 0, null);
      await stopping; await ready; expect(f.parent.finalizer.phase()).toBe('review-required'); expect(f.ledger.contents).not.toContain('private-sentinel');
    }
  );
});
