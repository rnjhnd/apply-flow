import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { canonicalOwner, type Owner } from './ownership.js';
import { createJournal } from './journal.js';
import { acquireLease } from './safety-io.js';
import { createFinalizer } from './finalization.js';
import { createChildRecorder } from './child-protocol.js';
import { createIntentClient } from './intent-client.js';
import { fileEvidence } from './evidence-files.js';
import { composeParent } from './composition.js';
import { owner, email, userId, memoryIo, leaseIo, fakeDatabase } from './b1-fakes.js';

describe('B1 audit correction: immutable allowlisted ownership projection', () => {
  it('strips extra context before journals, leases, ledgers, and both IPC directions', async () => {
    const source = { ...owner, databaseUrl: 'databaseUrl-sentinel', password: 'password-sentinel', cookie: 'cookie-sentinel',
      arbitrary: 'arbitrary-sentinel', response: { secret: 'body-sentinel' } };
    const canonical = canonicalOwner(source);
    expect(canonical).toEqual(owner); expect(Object.keys(canonical)).toEqual(['runId', 'testId']); expect(Object.isFrozen(canonical)).toBe(true);
    const journal = memoryIo(); const ledger = memoryIo(); const leases = leaseIo(); const child = new EventEmitter();
    const writer = createJournal(journal, source); const lease = acquireLease(leases, source, 'finalizer');
    const finalizer = createFinalizer(source, journal, ledger, lease, child);
    const ipcJournal = memoryIo(); const channel = new EventEmitter(); const sent: unknown[] = []; const review = vi.fn();
    const recorder = createChildRecorder(source, ipcJournal, async (ack) => { sent.push(ack); channel.emit('message', ack); }, review);
    const client = createIntentClient(source, ipcJournal, channel, (message, callback) => {
      sent.push(message); void recorder.intent(message).then(() => callback(null), () => callback(new Error('delivery failed')));
    }, review);
    // Each boundary retains its own canonical snapshot rather than this object.
    source.runId = userId; source.testId = userId;
    expect(await client.admit('a')).toBe(email); recorder.assertIntent(email); client.close();
    await recorder.seal(async () => undefined);
    finalizer.quiesce(); finalizer.acceptSeal(writer.sealForHandoff()); child.emit('exit', 0, null);
    await finalizer.finalize(fakeDatabase().database);
    const evidence = [journal.contents, ledger.contents, ...leases.entries.values(), ipcJournal.contents, JSON.stringify(sent)].join('\n');
    for (const secret of ['databaseUrl-sentinel', 'password-sentinel', 'cookie-sentinel', 'arbitrary-sentinel', 'body-sentinel']) expect(evidence).not.toContain(secret);
    expect(sent).toHaveLength(2); expect(Object.keys(sent[0] as object).sort()).toEqual(['email', 'messageId', 'runId', 'testId', 'type']);
    expect(Object.keys(sent[1] as object).sort()).toEqual(['digest', 'messageId', 'runId', 'sequence', 'testId', 'type']);
    expect(review).not.toHaveBeenCalled(); expect(finalizer.phase()).toBe('cleanup-eligible');
  });
  it.each([{ ...owner, runId: '../outside' }, { ...owner, testId: 'bad-id' }, { runId: null, testId: owner.testId }, {}])(
    'rejects malformed IDs before any evidence, IPC, or spawn side effect (%#)', (input) => {
      const invalid = input as Owner; const io = memoryIo(); const leases = leaseIo();
      const append = vi.spyOn(io, 'append'); const read = vi.spyOn(io, 'read'); const claim = vi.spyOn(leases, 'claim');
      const send = vi.fn(); const review = vi.fn(); const child = new EventEmitter(); const spawn = vi.fn();
      const lease = acquireLease(leaseIo(), owner, 'finalizer');
      for (const attempt of [
        () => canonicalOwner(invalid), () => createJournal(io, invalid), () => acquireLease(leases, invalid, 'finalizer'),
        () => createFinalizer(invalid, io, io, lease, child), () => createChildRecorder(invalid, io, send, review),
        () => createIntentClient(invalid, io, child, send, review), () => fileEvidence(invalid),
        () => composeParent(invalid, io, io, lease, spawn)
      ]) expect(attempt).toThrow(/^Invalid fixture owner\.$/);
      expect(append).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    }
  );
});
