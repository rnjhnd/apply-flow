import { describe, expect, it, vi } from 'vitest';
import { acquireLease, durableAppend } from './safety-io.js';
import { createFinalizer, resolveIntentUsers, withCleanupPermit } from './finalization.js';
import { readJournalSnapshot } from './journal.js';
import { digest } from './schema.js';
import { ownedEmail } from './ownership.js';
import { owner, userId, email, hash, finalizationFixture, fakeDatabase, leaseIo, memoryIo, deferred, inspection } from './b1-fakes.js';

const events = [{ kind: 'email' as const, value: email }, { kind: 'tokenHash' as const, value: hash }];
describe('B1 ownership leases, parent-observed exit, and durable finalization', () => {
  it('resolves only exact pre-recorded emails with bound parameters, never a namespace scan', async () => {
    const fake = fakeDatabase(); expect(await resolveIntentUsers(fake.tx, [])).toEqual([]); expect(fake.query).not.toHaveBeenCalled();
    await resolveIntentUsers(fake.tx, [email]); const query = fake.query.mock.calls[0]![0];
    expect(query.values).toEqual([email]); expect(query.sql).toContain('WHERE email IN'); expect(query.sql).toContain('FOR KEY SHARE');
    expect(query.sql).not.toMatch(/LIKE|prefix|createdAt|expiresAt/i);
  });
  it('cannot finalize when the guarded resolver transaction fails identity admission', async () => {
    const f = finalizationFixture(events); f.exit(); const fake = fakeDatabase();
    const data = inspection(); data.identity.username = 'wrong'; fake.inspect.mockResolvedValue(data);
    const resolver = vi.fn(); await expect(f.finalizer.finalize(fake.database, resolver)).rejects.toThrow('review');
    expect(resolver).not.toHaveBeenCalled(); expect(fake.stats.rollbacks).toBe(1); expect(f.finalizer.phase()).toBe('review-required');
  });
  it('requires exclusive run and finalizer leases, never steals or releases another owner', () => {
    const io = leaseIo(); const lease = acquireLease(io, owner, 'run');
    expect(() => acquireLease(io, owner, 'run')).toThrow();
    expect(() => acquireLease(io, { ...owner, testId: userId }, 'run')).toThrow();
    expect(() => lease.assertFor(owner, 'finalizer')).toThrow();
    expect(() => lease.assertFor({ ...owner, testId: userId }, 'run')).toThrow();
    lease.release(); expect(() => lease.assertHeld()).toThrow(); expect(() => lease.release()).toThrow();
    acquireLease(io, owner, 'run').assertHeld();
  });
  it('rejects lease tampering and asynchronous claims or evidence writes', () => {
    const io = leaseIo(); const lease = acquireLease(io, owner, 'finalizer');
    io.entries.clear(); expect(() => lease.assertHeld()).toThrow(); expect(() => lease.release()).toThrow();
    expect(() => acquireLease({ ...io, claim: (() => Promise.resolve()) as unknown as typeof io.claim }, owner, 'run')).toThrow('synchronous');
    expect(() => durableAppend({ read: () => '', append: (() => Promise.resolve()) as unknown as ReturnType<typeof memoryIo>['append'] }, {})).toThrow('synchronous');
  });
  it('requires exact finalizer lease ownership and an existing valid journal', () => {
    const fixture = finalizationFixture();
    const wrongLease = acquireLease(leaseIo(), owner, 'run');
    expect(() => createFinalizer(owner, fixture.journal, memoryIo(), wrongLease, fixture.child)).toThrow('lease');
    expect(() => createFinalizer(owner, memoryIo(), memoryIo(), fixture.lease, fixture.child)).toThrow('journal');
  });
  it('follows every lifecycle phase with chained durable digests before cleanup', async () => {
    const f = finalizationFixture(events); const database = fakeDatabase().database;
    expect(f.finalizer.phase()).toBe('recording'); f.exit();
    expect(f.finalizer.phase()).toBe('exit-confirmed');
    const resolve = vi.fn(async (_tx, emails: readonly string[]) => {
      expect(emails).toEqual([email]); expect(Object.isFrozen(emails)).toBe(true); return [{ id: userId.toUpperCase(), email }];
    });
    const permit = await f.finalizer.finalize(database, resolve);
    expect(f.finalizer.phase()).toBe('cleanup-eligible');
    const snapshot = readJournalSnapshot(f.journal, owner);
    expect(snapshot.journal.state).toBe('stopped');
    expect(snapshot.journal.events.at(-1)).toEqual({ kind: 'user', value: userId, email });
    const work = vi.fn(async (targets) => { expect(targets).toEqual({ users: [{ id: userId, email }], hashes: [hash] }); });
    await withCleanupPermit(permit, work); expect(f.finalizer.phase()).toBe('cleaned');
    await withCleanupPermit(permit, work); expect(work).toHaveBeenCalledOnce();
    expect(await f.finalizer.finalize(database, resolve)).toBe(permit); expect(resolve).toHaveBeenCalledOnce();
    const lines = f.ledger.contents.trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line).phase)).toEqual(['recording', 'quiescing', 'child-sealed', 'exit-confirmed', 'finalizing', 'cleanup-eligible', 'cleaned']);
    lines.forEach((line, index) => {
      const entry = JSON.parse(line); expect(entry.sequence).toBe(index);
      expect(entry.previousDigest).toBe(index ? digest(`${lines[index - 1]}\n`) : null);
    });
    expect(JSON.parse(lines.at(-1)!).seal).toEqual({ sequence: snapshot.sequence, digest: snapshot.digest });
    expect(() => f.writer.record({ kind: 'tokenHash', value: 'b'.repeat(64) })).toThrow('closed');
    expect(() => f.writer.markExited()).toThrow('closed');
  });
  it('does not infer exit from a seal, shutdown intent, or a forged permit', async () => {
    const f = finalizationFixture(); f.finalizer.quiesce(); f.finalizer.acceptSeal(f.writer.sealForHandoff());
    await expect(f.finalizer.finalize(fakeDatabase().database, vi.fn())).rejects.toThrow('not admitted');
    const work = vi.fn(); await expect(withCleanupPermit({ ownership: 'parent-finalized' }, work)).rejects.toThrow('not admitted');
    expect(work).not.toHaveBeenCalled();
  });
  it.each(['crash', 'signal', 'disconnect', 'error', 'early-exit', 'escalation'])('retains evidence after %s', async (failure) => {
    const f = finalizationFixture(events);
    if (failure !== 'early-exit') { f.finalizer.quiesce(); f.finalizer.acceptSeal(f.writer.sealForHandoff()); }
    if (failure === 'disconnect' || failure === 'error') f.child.emit(failure, new Error('private detail'));
    else if (failure === 'escalation') f.finalizer.review();
    else f.child.emit('exit', failure === 'crash' ? 1 : failure === 'signal' ? null : 0, failure === 'signal' ? 'SIGTERM' : null);
    expect(f.finalizer.phase()).toBe('review-required');
    await expect(f.finalizer.finalize(fakeDatabase().database, vi.fn())).rejects.toThrow('not admitted');
    expect(readJournalSnapshot(f.journal, owner).journal.state).toBe('running');
  });
  it('permits a failed assertion followed by otherwise clean shutdown', async () => {
    const f = finalizationFixture(); const assertion = new Error('test failed');
    expect(assertion).toBeInstanceOf(Error); // Test result does not fabricate a process crash.
    f.exit(); await f.finalizer.finalize(fakeDatabase().database, vi.fn());
    expect(f.finalizer.phase()).toBe('cleanup-eligible');
  });
  it.each(['duplicate-user', 'duplicate-email', 'unexpected-email', 'conflicting-id'])('rejects %s resolution', async (kind) => {
    const recorded = kind === 'conflicting-id' ? [...events, { kind: 'user' as const, value: userId, email }] : events;
    const f = finalizationFixture(recorded); f.exit();
    const rows = kind === 'duplicate-user' ? [{ id: userId, email }, { id: userId, email: ownedEmail(owner, 'b') }]
      : kind === 'duplicate-email' ? [{ id: userId, email }, { id: owner.runId, email }]
      : kind === 'unexpected-email' ? [{ id: userId, email: ownedEmail(owner, 'b') }] : [{ id: owner.runId, email }];
    await expect(f.finalizer.finalize(fakeDatabase().database, async () => rows)).rejects.toThrow('requires review');
    expect(f.finalizer.phase()).toBe('review-required'); expect(readJournalSnapshot(f.journal, owner).journal.state).toBe('running');
  });
  it('rejects a bad seal and tampered ownership after sealing', async () => {
    const f = finalizationFixture(); f.finalizer.quiesce();
    expect(() => f.finalizer.acceptSeal({ sequence: 0, digest: hash })).toThrow('review');
    const other = finalizationFixture(events); other.exit(); other.journal.contents = other.journal.contents.replace(email, ownedEmail(owner, 'b'));
    await expect(other.finalizer.finalize(fakeDatabase().database, vi.fn())).rejects.toThrow('review');
  });
  it('rejects a changed ledger or released lease before cleanup', async () => {
    for (const changed of ['ledger', 'lease']) {
      const f = finalizationFixture(); f.exit(); const permit = await f.finalizer.finalize(fakeDatabase().database, vi.fn());
      if (changed === 'ledger') f.ledger.contents += '{}\n'; else f.lease.release();
      const work = vi.fn(); await expect(withCleanupPermit(permit, work)).rejects.toThrow('review'); expect(work).not.toHaveBeenCalled();
    }
  });
  it('rejects duplicate coordinators and concurrent finalization without duplicate resolution', async () => {
    const f = finalizationFixture(events);
    expect(() => createFinalizer(owner, f.journal, f.ledger, f.lease, f.child)).toThrow();
    expect(() => createFinalizer(owner, f.journal, memoryIo(), f.lease, f.child)).toThrow('already assigned');
    f.exit(); const wait = deferred<unknown>(); const resolver = vi.fn(() => wait.promise);
    const pending = f.finalizer.finalize(fakeDatabase().database, resolver);
    await expect(f.finalizer.finalize(fakeDatabase().database, resolver)).rejects.toThrow('not admitted');
    wait.resolve([]); await pending; expect(resolver).toHaveBeenCalledOnce();
  });
  it.each(['ledger', 'journal', 'terminal-ledger'])('requires review on %s durable-write failure', async (location) => {
    const f = finalizationFixture(events); f.exit();
    if (location === 'ledger') f.ledger.fail = true;
    if (location === 'journal') f.journal.fail = true;
    if (location === 'terminal-ledger') {
      const append = f.ledger.append.bind(f.ledger);
      vi.spyOn(f.ledger, 'append').mockImplementation((line, exclusive) => {
        if (JSON.parse(line).phase === 'cleanup-eligible') throw new Error('fsync failed'); append(line, exclusive);
      });
    }
    await expect(f.finalizer.finalize(fakeDatabase().database, async () => [{ id: userId, email }])).rejects.toThrow('review');
    expect(f.finalizer.phase()).toBe('review-required');
  });
  it('keeps evidence and refuses replay after an ambiguous cleanup commit', async () => {
    const f = finalizationFixture(events); f.exit(); const permit = await f.finalizer.finalize(fakeDatabase().database, async () => []);
    const work = vi.fn(async () => { throw new Error('connection lost at commit with private credentials'); });
    await expect(withCleanupPermit(permit, work)).rejects.toThrow(/^Cleanup requires review\.$/);
    await expect(withCleanupPermit(permit, work)).rejects.toThrow('review');
    expect(work).toHaveBeenCalledOnce(); expect(f.ledger.contents).not.toContain('private credentials');
    expect(readJournalSnapshot(f.journal, owner).journal.state).toBe('stopped');
  });
  it('cannot reopen terminal evidence in a new parent instance', async () => {
    const f = finalizationFixture(); f.exit(); await f.finalizer.finalize(fakeDatabase().database, vi.fn());
    expect(() => createFinalizer(owner, f.journal, f.ledger, f.lease, f.child)).toThrow();
    f.finalizer.detach(); expect(f.child.listenerCount('exit')).toBe(0);
    expect(f.child.listenerCount('disconnect')).toBe(0); expect(f.child.listenerCount('error')).toBe(0);
  });
});

describe('B1 audit corrections: terminal review and controlled channel closure', () => {
  it.each(['success', 'failure'] as const)('never resurrects review after pending resolution %s', async (outcome) => {
    const f = finalizationFixture(events); f.exit(); const fake = fakeDatabase();
    const entered = deferred(); const resolution = deferred<unknown>();
    const pending = f.finalizer.finalize(fake.database, async () => { entered.resolve(); return resolution.promise; });
    const failed = expect(pending).rejects.toThrow(/^Finalization requires review\.$/);
    await entered.promise;
    await expect(f.finalizer.finalize(fake.database, vi.fn())).rejects.toThrow('not admitted');
    f.finalizer.review(); const reviewed = f.ledger.contents; f.finalizer.review(); expect(f.ledger.contents).toBe(reviewed);
    if (outcome === 'success') resolution.resolve([{ id: userId, email }]); else resolution.reject(new Error('private resolver details'));
    await failed;
    expect(f.finalizer.phase()).toBe('review-required'); expect(fake.stats).toEqual({ commits: 0, rollbacks: 1 });
    expect(readJournalSnapshot(f.journal, owner).journal.state).toBe('running');
    expect(f.ledger.contents).not.toContain('cleanup-eligible'); expect(f.ledger.contents).not.toContain('private resolver details');
    await expect(f.finalizer.finalize(fake.database, vi.fn())).rejects.toThrow('not admitted');
  });
  it('rejects review after resolver commit but before finalization continuation writes ownership', async () => {
    const f = finalizationFixture(events); f.exit(); const fake = fakeDatabase();
    const database: typeof fake.database = { async $transaction(work, assertAuthority) {
      const value = await fake.database.$transaction(work, assertAuthority); f.finalizer.review(); return value;
    } };
    await expect(f.finalizer.finalize(database, async () => [{ id: userId, email }])).rejects.toThrow('review');
    expect(f.finalizer.phase()).toBe('review-required'); expect(readJournalSnapshot(f.journal, owner).journal.events).toEqual(events);
    expect(f.ledger.contents).not.toContain('cleanup-eligible');
  });
  it.each(['ownership-append', 'terminal-stop', 'eligibility-append', 'permit-issuance'] as const)(
    'rejects review during %s without issuing a permit or corrupting ledger ordering', async (boundary) => {
      const f = finalizationFixture(events); f.exit(); let injected = false;
      if (boundary === 'ownership-append' || boundary === 'terminal-stop') {
        const append = f.journal.append.bind(f.journal);
        vi.spyOn(f.journal, 'append').mockImplementation((line, exclusive) => {
          const value = JSON.parse(line);
          if (!injected && (boundary === 'terminal-stop' ? value.journal.state === 'stopped' : value.journal.events.at(-1)?.kind === 'user')) {
            injected = true; f.finalizer.review();
          }
          append(line, exclusive);
        });
      } else if (boundary === 'eligibility-append') {
        const append = f.ledger.append.bind(f.ledger);
        vi.spyOn(f.ledger, 'append').mockImplementation((line, exclusive) => {
          if (!injected && JSON.parse(line).phase === 'cleanup-eligible') { injected = true; f.finalizer.review(); }
          append(line, exclusive);
        });
      } else {
        const read = f.ledger.read.bind(f.ledger);
        vi.spyOn(f.ledger, 'read').mockImplementation(() => {
          if (!injected && f.finalizer.phase() === 'cleanup-eligible') { injected = true; f.finalizer.review(); }
          return read();
        });
      }
      let permitIssued = false;
      await expect(f.finalizer.finalize(fakeDatabase().database, async () => [{ id: userId, email }]).then(() => { permitIssued = true; }))
        .rejects.toThrow('review');
      expect(injected).toBe(true); expect(permitIssued).toBe(false); expect(f.finalizer.phase()).toBe('review-required');
      const lines = f.ledger.contents.trimEnd().split('\n');
      expect(JSON.parse(lines.at(-1)!).phase).toBe('review-required');
      lines.forEach((line, index) => {
        const entry = JSON.parse(line); expect(entry.sequence).toBe(index);
        expect(entry.previousDigest).toBe(index ? digest(`${lines[index - 1]}\n`) : null);
      });
    }
  );
  it('requires a validated seal and explicit closure expectation before disconnect, and still requires real exit', async () => {
    const f = finalizationFixture(events); f.finalizer.quiesce(); f.finalizer.acceptSeal(f.writer.sealForHandoff());
    f.finalizer.expectChannelClosure(); f.finalizer.expectChannelClosure();
    f.child.emit('disconnect'); f.child.emit('disconnect'); expect(f.finalizer.phase()).toBe('child-sealed');
    await expect(f.finalizer.finalize(fakeDatabase().database, vi.fn())).rejects.toThrow('not admitted');
    f.child.emit('exit', 0, null); expect(f.finalizer.phase()).toBe('exit-confirmed');
    await f.finalizer.finalize(fakeDatabase().database, async () => []); expect(f.finalizer.phase()).toBe('cleanup-eligible');
  });
  it.each(['missing-seal', 'bad-seal', 'unexplained-disconnect', 'error', 'signal', 'escalation'] as const)(
    'retains review for %s even if a normal exit is reported later', (failure) => {
      const f = finalizationFixture(); f.finalizer.quiesce();
      if (failure === 'missing-seal') expect(() => f.finalizer.expectChannelClosure()).toThrow('review');
      else if (failure === 'bad-seal') expect(() => f.finalizer.acceptSeal({ sequence: 0, digest: hash })).toThrow('review');
      else {
        f.finalizer.acceptSeal(f.writer.sealForHandoff());
        if (failure !== 'unexplained-disconnect') f.finalizer.expectChannelClosure();
        if (failure === 'error') f.child.emit('error', new Error('private child details'));
        else if (failure === 'signal') f.child.emit('exit', null, 'SIGTERM');
        else if (failure === 'escalation') f.finalizer.review();
        else f.child.emit('disconnect');
      }
      f.child.emit('exit', 0, null); expect(f.finalizer.phase()).toBe('review-required');
    }
  );
});
