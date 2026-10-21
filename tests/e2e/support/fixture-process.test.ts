import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFixtureParent, createFixtureSpawn, fixtureChildEntry, type FixtureChildHandle } from './fixture-process.js';
import { createFixtureChild, createFixtureExitHost } from './fixture-child.js';
import type { openFixtureDatabase } from './fixture-database.js';
import { finishFixtureLifecycle } from './fixture-lifecycle.js';
import { acquireLease } from './safety-io.js';
import { executeCleanup, type CleanupRepository } from './cleanup.js';
import { resolveIntentUsers } from './finalization.js';
import { recordedUsers } from './fixture-services.js';
import { owner, email, userId, hash, env, sql, memoryIo, leaseIo, fakeDatabase, deferred } from './b1-fakes.js';

type Connection = Awaited<ReturnType<typeof openFixtureDatabase>>;
function fixture() {
  const journal = memoryIo(); const ledger = memoryIo(); const operations = memoryIo(); const io = leaseIo();
  const leases = { run: acquireLease(io, owner, 'run'), finalizer: acquireLease(io, owner, 'finalizer') };
  const review = vi.fn(); let closed = false;
  const connection = {
    cycle: vi.fn(async (_email, recorder, evidence) => recorder.request(async () => {
      const a = randomUUID(); const r = randomUUID();
      evidence.start(a, 'anonymous'); recorder.record({ kind: 'tokenHash', value: hash });
      evidence.observe(a, 'anonymous', { kind: 'session', id: randomUUID(), tokenHash: hash, userId: null }); evidence.committed(a, 'anonymous');
      evidence.start(r, 'registration'); recorder.record({ kind: 'user', value: userId, email });
      evidence.observe(r, 'registration', { kind: 'user', id: userId, email }); evidence.committed(r, 'registration');
      return { usersCreated: 1, sessionsCreated: 2, rotations: 1 };
    })), close: vi.fn(async () => { closed = true; }), isClosed: () => closed
  } as unknown as Connection;
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
    send: vi.fn<(message: unknown, callback: (error: Error | null) => void) => void>(),
    kill: vi.fn(() => { child.exitCode = null; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); }) });
  const sendParent = vi.fn(async (message: unknown) => { child.emit('message', message); });
  const disconnect = vi.fn(() => { child.emit('disconnect'); });
  // Model Node's exit ordering: listeners run before the final exitCode is
  // observed by the parent. No real process exit/global status is modified.
  const exit = vi.fn((code: number) => naturalExit(code));
  const port = Object.assign(new EventEmitter(), { exitCode: undefined as number | string | undefined, exit });
  const host = createFixtureExitHost(port);
  function naturalExit(code?: number) {
    if (code !== undefined) port.exitCode = code;
    port.emit('exit');
    child.exitCode = Number(port.exitCode ?? 0); child.signalCode = null;
    child.emit('exit', child.exitCode, child.signalCode);
  }
  const handled: Promise<void>[] = [];
  const runtime = createFixtureChild(env, owner, { journal, operations }, { send: sendParent,
    connect: vi.fn(async () => connection), review, disconnect, exitHost: host }, 100);
  child.send.mockImplementation((message, callback) => {
    queueMicrotask(() => {
      callback(null); // Transport acceptance is independent of handler settlement.
      const work = runtime.receive(message); handled.push(work); void work.catch(() => undefined);
    });
  });
  const spawn = vi.fn(() => child as FixtureChildHandle); const preflight = vi.fn(async () => undefined);
  const start = () => startFixtureParent(env, sql, owner, { journal, ledger, operations }, leases, { preflight, spawn },
    { startup: 100, work: 100, grace: 20, exit: 20, ipc: 100 });
  return { journal, ledger, operations, leases, review, connection, runtime, child, sendParent, spawn, preflight, start, disconnect, exit,
    host, port, naturalExit, settle: () => Promise.allSettled(handled) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('B3 real headless protocol composed with injected child/database/files', () => {
  it('uses only current Node, fixed TS entry, clean environment, hidden window and IPC-only communication', () => {
    const child = new EventEmitter() as FixtureChildHandle;
    const spawn = vi.fn(() => child); const adapter = createFixtureSpawn(spawn);
    expect(adapter({ entry: fixtureChildEntry, environment: { ...env, UNRELATED_SECRET: 'not-forwarded' }, shell: false, windowsHide: true })).toBe(child);
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['--import', 'tsx', fixtureChildEntry], expect.objectContaining({
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }));
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('not-forwarded');
  });
  it.each(['entry', 'environment'])('rejects unsafe process %s before injected spawn', (kind) => {
    const spawn = vi.fn(); const adapter = createFixtureSpawn(spawn);
    expect(() => adapter({ entry: kind === 'entry' ? 'other.ts' : fixtureChildEntry,
      environment: kind === 'environment' ? { ...env, NODE_OPTIONS: '--inspect' } : env, shell: false, windowsHide: true })).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('lets child exclusively create journal, validates/acks admission, settles and observes exit before finalization', async () => {
    const f = fixture(); expect(f.journal.contents).toBe(''); const parent = await f.start();
    expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ entry: fixtureChildEntry, shell: false, windowsHide: true }));
    expect(f.preflight.mock.invocationCallOrder[0]!).toBeLessThan(f.spawn.mock.invocationCallOrder[0]!);
    expect(f.runtime.state()).toBe('ready'); expect(parent.isHealthy()).toBe(true);
    expect(() => parent.finalizer()).toThrow('not admitted');
    await parent.run();
    const stopping = parent.stop(); expect(parent.stop()).toBe(stopping); expect(parent.isHealthy()).toBe(false);
    await stopping; expect(f.connection.close).toHaveBeenCalledOnce(); expect(f.runtime.state()).toBe('closed');
    expect(parent.finalizer().phase()).toBe('exit-confirmed'); expect(f.child.kill).not.toHaveBeenCalled();
    for (const name of ['message', 'exit', 'disconnect', 'error']) expect(f.child.listenerCount(name)).toBe(0);
    const db = fakeDatabase(); db.query.mockResolvedValue([{ id: userId, email }]);
    const permit = await parent.finalizer().finalize(db.database, async (tx, emails) => recordedUsers(owner, f.journal, emails, await resolveIntentUsers(tx, emails)));
    const repository: CleanupRepository = { lock: vi.fn(async () => ({ users: [{ id: userId, email }], sessions: [{ tokenHash: hash, userId }] })),
      deleteSessions: vi.fn(async (_tx, rows) => rows), deleteUsers: vi.fn(async (_tx, rows) => rows), verifyAbsent: vi.fn(async () => true) };
    await executeCleanup(permit, db.database, repository); expect(parent.finalizer).toBeDefined();
    expect(f.ledger.contents).toContain('"phase":"cleaned"'); expect(f.review).not.toHaveBeenCalled();
    parent.release(); parent.release(); expect(() => f.leases.run.assertHeld()).toThrow();
  });
  it.each(['environment', 'migration', 'preflight', 'lease'])('does not spawn after %s admission failure', async (kind) => {
    const f = fixture();
    if (kind === 'preflight') f.preflight.mockRejectedValue(new Error());
    if (kind === 'lease') f.leases.run.release();
    const starting = kind === 'environment' || kind === 'migration'
      ? startFixtureParent(kind === 'environment' ? { ...env, NODE_ENV: 'production' } : env,
        kind === 'migration' ? Buffer.from('changed') : sql, owner, { journal: f.journal, ledger: f.ledger, operations: f.operations },
        f.leases, { preflight: f.preflight, spawn: f.spawn }) : f.start();
    await expect(starting).rejects.toThrow(); expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['sync', 'async', 'bad-receipt'])('fails startup closed for %s IPC failure', async (kind) => {
    const f = fixture();
    if (kind === 'sync') f.child.send.mockImplementation(() => { throw new Error('private'); });
    if (kind === 'async') f.child.send.mockImplementation((_message, callback) => callback(new Error('private')));
    if (kind === 'bad-receipt') f.sendParent.mockImplementation(async (message) => {
      f.child.emit('message', { ...(message as object), digest: hash });
    });
    await expect(f.start()).rejects.toThrow('review'); expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.ledger.contents).not.toContain('cleanup-eligible');
  });
  it('rejects duplicate run and does not issue a second service operation', async () => {
    const f = fixture(); const parent = await f.start(); const first = parent.run();
    await expect(parent.run()).rejects.toThrow('not admitted'); await first; await parent.stop(); expect(f.connection.cycle).toHaveBeenCalledOnce();
  });
  it('does not use IPC disconnect or code zero without a seal as exit evidence', async () => {
    const f = fixture(); const parent = await f.start(); f.child.emit('disconnect'); f.child.emit('exit', 0, null);
    await expect(parent.stop()).rejects.toThrow('review'); expect(() => parent.finalizer()).toThrow();
  });
  it('refuses finalization after operation evidence changes after sealing', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run(); await parent.stop(); const finalizer = parent.finalizer();
    f.operations.contents += 'corrupt\n';
    await expect(finalizer.finalize(fakeDatabase().database)).rejects.toThrow('review'); expect(finalizer.phase()).toBe('review-required');
  });
  it('never seals or admits cleanup if database closure is uncertain', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run(); vi.mocked(f.connection.close).mockRejectedValue(new Error('secret'));
    await expect(parent.stop()).rejects.toThrow('review'); expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.ledger.contents).not.toContain('cleanup-eligible');
  });
  it('keeps late-settling work tracked without granting a seal after interruption', async () => {
    const f = fixture(); const parent = await f.start(); const held = deferred(); const entered = deferred();
    vi.mocked(f.connection.cycle).mockImplementationOnce(async (_email, recorder) => recorder.request(async () => { entered.resolve(); await held.promise; throw new Error('late'); }));
    const running = parent.run(); const rejected = expect(running).rejects.toThrow('review'); await entered.promise;
    f.runtime.interrupt(); parent.review(); held.resolve(); await rejected;
    await expect(parent.stop()).rejects.toThrow('review'); expect(f.ledger.contents).not.toContain('child-sealed');
  });
  it('does not publish cycle completion when an interrupted operation later returns success', async () => {
    const f = fixture(); const parent = await f.start(); const entered = deferred(); const held = deferred();
    const normal = vi.mocked(f.connection.cycle).getMockImplementation()!;
    vi.mocked(f.connection.cycle).mockImplementationOnce(async (...args) => {
      const value = await normal(...args); entered.resolve(); await held.promise; return value;
    });
    const running = parent.run(); const rejected = expect(running).rejects.toThrow('review'); await entered.promise;
    f.runtime.interrupt(); held.resolve(); await rejected;
    expect(f.sendParent.mock.calls.some(([value]) => (value as { type: string }).type === 'cycle-complete')).toBe(false);
    await expect(parent.stop()).rejects.toThrow('review');
  });
  it.each(['seal-ack', 'closure-ack'])('keeps review terminal when interrupted immediately after %s resolves', async (type) => {
    const f = fixture(); const parent = await f.start(); await parent.run();
    const deliver = f.child.send.getMockImplementation()!;
    f.child.send.mockImplementation((message, callback) => {
      if ((message as { type: string }).type !== type) { deliver(message, callback); return; }
      const completion = f.runtime.receive(message); // Resolves the exact waiter synchronously.
      f.runtime.interrupt(); f.runtime.interrupt();
      // A subsequent code-zero exit must not overwrite the parent's review evidence.
      f.child.emit('exit', 0, null);
      void completion.then(() => callback(null), () => callback(new Error('private IPC sentinel')));
    });
    await expect(parent.stop()).rejects.toThrow('review');
    expect(f.runtime.state()).toBe('review'); expect(f.review).toHaveBeenCalledOnce();
    expect(f.disconnect).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled();
    expect(() => parent.finalizer()).toThrow('not admitted');
    // Review latches admission before best-effort ledger persistence. Existing
    // lease checks may reject that append; sealed evidence must remain intact.
    expect(parent.isHealthy()).toBe(false);
    expect(f.ledger.contents).toContain('"phase":"child-sealed"');
    expect(f.ledger.contents).not.toContain('"phase":"exit-confirmed"');
    expect(f.ledger.contents).not.toContain('cleanup-eligible');
    expect(f.sendParent.mock.calls.filter(([message]) => (message as { type: string }).type === 'review-required')).toHaveLength(1);
  });
  it('rechecks authority between disconnect and successful exit', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run();
    f.disconnect.mockImplementation(() => {
      f.child.emit('disconnect'); f.runtime.interrupt(); f.runtime.interrupt(); f.child.emit('exit', 0, null);
    });
    await expect(parent.stop()).rejects.toThrow('review');
    expect(f.runtime.state()).toBe('review'); expect(f.exit).not.toHaveBeenCalled();
    expect(() => parent.finalizer()).toThrow('not admitted'); expect(f.review).toHaveBeenCalledOnce();
  });
  it('rejects a late shutdown-send continuation after the closing acknowledgment and interruption', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run();
    const entered = deferred(); const held = deferred(); const send = f.sendParent.getMockImplementation()!;
    f.sendParent.mockImplementation(async (message) => {
      await send(message);
      if ((message as { type: string }).type === 'channel-closing') { entered.resolve(); await held.promise; }
    });
    const stopping = parent.stop(); const rejected = expect(stopping).rejects.toThrow('review');
    await entered.promise;
    f.runtime.interrupt(); f.runtime.interrupt(); f.child.emit('exit', 0, null); held.resolve();
    await rejected;
    expect(f.runtime.state()).toBe('review'); expect(f.disconnect).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled();
    expect(() => parent.finalizer()).toThrow('not admitted'); expect(f.review).toHaveBeenCalledOnce();
  });
  it.each(['send-rejected', 'transport-only', 'delayed-handling'] as const)(
    'rejects the audited closure-ack interruption independently of review notification: %s', async (delivery) => {
      const f = fixture(); const parent = await f.start(); await parent.run();
      const send = f.sendParent.getMockImplementation()!; const held = deferred();
      const parentHandling: Promise<void>[] = [];
      f.sendParent.mockImplementation(async (message) => {
        if ((message as { type: string }).type === 'review-required') {
          if (delivery === 'send-rejected') throw new Error('private IPC sentinel');
          if (delivery === 'transport-only') return; // Accepted transport, no parent processing.
          // Transport completes now; parent application handling is independent.
          const later = held.promise.then(() => send(message)); parentHandling.push(later);
          void later.catch(() => undefined); return;
        }
        await send(message);
      });
      f.review.mockImplementation(() => { throw new Error('private review persistence sentinel'); });
      const deliver = f.child.send.getMockImplementation()!; const continuations: Promise<void>[] = [];
      let statusAtInterruption: number | string | undefined;
      f.child.send.mockImplementation((message, callback) => {
        if ((message as { type: string }).type !== 'closure-ack') { deliver(message, callback); return; }
        callback(null); // Transport receipt precedes child application handling.
        const work = f.runtime.receive(message); continuations.push(work); void work.catch(() => undefined);
        // Waiter resolved, but its shutdown continuation has not resumed yet.
        f.ledger.fail = true;
        f.runtime.interrupt(); f.runtime.interrupt(); statusAtInterruption = f.port.exitCode;
        f.port.exitCode = 0; // A later callback attempts to reset natural exit status.
        f.naturalExit(0); // Owned exit enforcement must restore failure before observation.
      });
      await expect(parent.stop()).rejects.toThrow('review');
      held.resolve(); await Promise.allSettled([...continuations, ...parentHandling]); await f.settle();
      expect(statusAtInterruption).toBe(1); expect(f.host.failureLatched()).toBe(true);
      expect(f.port.exitCode).toBe(1); expect(f.child.exitCode).toBe(1); expect(f.runtime.state()).toBe('review');
      expect(f.exit).not.toHaveBeenCalled(); expect(f.review).toHaveBeenCalledOnce();
      const finalize = vi.fn();
      expect(() => finalize(parent.finalizer())).toThrow('not admitted'); expect(finalize).not.toHaveBeenCalled();
      expect(f.ledger.contents).not.toContain('exit-confirmed'); expect(f.ledger.contents).not.toContain('cleanup-eligible');
      f.runtime.interrupt(); f.child.emit('exit', 0, null); // Late contradictory callback cannot reopen admission.
      expect(() => parent.finalizer()).toThrow('not admitted');
    }
  );
  it('does not confuse transport acknowledgment with completion of a pending service operation', async () => {
    const f = fixture(); const parent = await f.start(); const entered = deferred(); const held = deferred();
    const cycle = vi.mocked(f.connection.cycle).getMockImplementation()!;
    vi.mocked(f.connection.cycle).mockImplementation(async (...args) => { entered.resolve(); await held.promise; return cycle(...args); });
    const deliver = f.child.send.getMockImplementation()!; let transportAccepted = false; let completed = false;
    f.child.send.mockImplementation((message, callback) => deliver(message, (error) => {
      if ((message as { type: string }).type === 'run-cycle') transportAccepted = true;
      callback(error);
    }));
    const running = parent.run().then(() => { completed = true; }); await entered.promise;
    expect(transportAccepted).toBe(true); expect(completed).toBe(false); expect(() => parent.finalizer()).toThrow('not admitted');
    held.resolve(); await running; await parent.stop();
    expect(f.host.failureLatched()).toBe(false); expect(f.child.exitCode).toBe(0);
    expect(parent.finalizer().phase()).toBe('exit-confirmed');
  });
  it('latches failure before reporting and enforces it on an attempted explicit success exit', async () => {
    const f = fixture(); let reportingStatus: number | string | undefined;
    f.review.mockImplementation(() => { reportingStatus = f.port.exitCode; throw new Error('private report sentinel'); });
    f.sendParent.mockRejectedValue(new Error('private send sentinel'));
    expect(f.port.exitCode).toBe(1); // Unsettled natural termination is fail-closed from construction.
    f.runtime.interrupt(); f.runtime.interrupt();
    expect(reportingStatus).toBe(1); expect(f.host.failureLatched()).toBe(true);
    f.port.exitCode = 0; f.port.exit(0);
    expect(f.port.exitCode).toBe(1); expect(f.child.exitCode).toBe(1); expect(f.review).toHaveBeenCalledOnce();
    await Promise.resolve();
  });
  it('keeps the parent finalizer terminal when durable review persistence actually fails', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run(); await parent.stop();
    const finalizer = parent.finalizer(); const before = f.ledger.contents;
    const append = vi.spyOn(f.ledger, 'append'); f.ledger.fail = true;
    finalizer.review(); finalizer.review();
    expect(append).toHaveBeenCalledOnce(); expect(f.ledger.contents).toBe(before);
    expect(finalizer.phase()).toBe('review-required'); expect(() => parent.finalizer()).toThrow('not admitted');
    const database = fakeDatabase();
    await expect(finalizer.finalize(database.database)).rejects.toThrow('not admitted');
    expect(database.query).not.toHaveBeenCalled(); expect(f.ledger.contents).not.toContain('cleanup-eligible');
  });
  it.each(['forged', 'reused'] as const)('rejects a %s exit host before child journal/service construction', (kind) => {
    const f = fixture(); const journal = memoryIo(); const operations = memoryIo(); const connect = vi.fn(); const send = vi.fn();
    const exitHost = kind === 'reused' ? f.host : Object.freeze({ failureLatched: () => false });
    expect(() => createFixtureChild(env, owner, { journal, operations }, { exitHost, connect, send, disconnect: vi.fn(), review: vi.fn() }))
      .toThrow('exit host');
    expect(journal.contents).toBe(''); expect(connect).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each(['nonzero', 'missing-code', 'missing-signal', 'signal', 'handle-code', 'handle-signal', 'duplicate'] as const)(
    'rejects %s exit evidence even with valid sealed journal/operation evidence', async (kind) => {
      const f = fixture(); const parent = await f.start(); await parent.run(); const send = f.sendParent.getMockImplementation()!;
      f.sendParent.mockImplementation(async (message) => {
        if ((message as { type: string }).type !== 'review-required') await send(message);
      });
      const deliver = f.child.send.getMockImplementation()!;
      f.child.send.mockImplementation((message, callback) => {
        if ((message as { type: string }).type !== 'closure-ack') { deliver(message, callback); return; }
        callback(null); // Do not deliver closure-ack: the child cannot manufacture normal exit.
        const code = kind === 'missing-code' ? undefined : kind === 'nonzero' ? 1 : 0;
        const signal = kind === 'missing-signal' ? undefined : kind === 'signal' ? 'SIGTERM' : null;
        f.child.exitCode = kind === 'handle-code' ? 1 : code ?? null;
        f.child.signalCode = kind === 'handle-signal' ? 'SIGTERM' : signal ?? null;
        f.child.emit('exit', code, signal);
        if (kind === 'duplicate') f.child.emit('exit', code, signal);
      });
      await expect(parent.stop()).rejects.toThrow('review');
      // Settle the still-waiting child only after testing the parent's independent rejection.
      f.runtime.interrupt(); await f.settle();
      expect(() => parent.finalizer()).toThrow('not admitted'); expect(f.ledger.contents).not.toContain('cleanup-eligible');
    }
  );
  it('retains bounded owned-child termination when no exit can be observed', async () => {
    vi.useFakeTimers(); const f = fixture(); const parent = await f.start(); await parent.run();
    f.exit.mockImplementation(() => undefined);
    const stopping = parent.stop(); const rejected = expect(stopping).rejects.toThrow('review');
    await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(() => parent.finalizer()).toThrow('not admitted');
    expect(f.ledger.contents).not.toContain('cleanup-eligible');
  });
  it('refuses child operation dispatch before parent acknowledgment or exact intent', async () => {
    const f = fixture(); await expect(f.runtime.receive({ type: 'run-cycle', ...owner })).rejects.toThrow('review');
    expect(f.connection.cycle).not.toHaveBeenCalled(); expect(f.journal.contents).toBe('');
  });
  it('does not acknowledge a changed initial journal or wrong owner', async () => {
    const f = fixture(); await expect(f.runtime.receive({ type: 'initialize', ...owner, testId: randomUUID() })).rejects.toThrow('review');
    expect(f.journal.contents).toBe('');
  });
  it('leaves terminal evidence intact and does not reopen child initialization', async () => {
    const f = fixture(); const parent = await f.start(); await parent.run(); await parent.stop(); const before = f.journal.contents;
    await expect(f.runtime.receive({ type: 'initialize', ...owner })).rejects.toThrow('review'); expect(f.journal.contents).toBe(before);
  });
  it('does not connect the parent until shutdown has returned an admitted finalizer', async () => {
    const connect = vi.fn(); const parent = { run: vi.fn(async () => undefined), stop: vi.fn(async () => { throw new Error(); }),
      finalizer: vi.fn(), review: vi.fn() };
    await expect(finishFixtureLifecycle(parent as unknown as Awaited<ReturnType<typeof startFixtureParent>>, owner, memoryIo(), connect)).rejects.toThrow('review');
    expect(connect).not.toHaveBeenCalled(); expect(parent.review).toHaveBeenCalled();
  });
});
