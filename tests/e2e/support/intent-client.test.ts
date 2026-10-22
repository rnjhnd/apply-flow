import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntentClient, type Intent } from './intent-client.js';
import { createChildRecorder, type Acknowledgment } from './child-protocol.js';
import { createJournal, readJournalSnapshot } from './journal.js';
import { owner, email, hash, memoryIo } from './b1-fakes.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('B1 parent intent receipts over injected IPC', () => {
  function fixture() {
    const journal = memoryIo(); const channel = new EventEmitter(); const review = vi.fn();
    const writer = createJournal(journal, owner);
    const send = vi.fn<(message: Intent, callback: (error: Error | null) => void) => void>();
    const client = createIntentClient(owner, journal, channel, send, review, 10);
    return { journal, channel, review, writer, send, client };
  }
  function acknowledge(f: ReturnType<typeof fixture>, patch: Record<string, unknown> = {}) {
    const message = f.send.mock.calls[0]![0];
    const snapshot = readJournalSnapshot(f.journal, owner);
    const ack = { type: 'intent-ack', ...owner, messageId: message.messageId, sequence: snapshot.sequence, digest: snapshot.digest, ...patch };
    f.channel.emit('message', ack); return ack;
  }
  it('admits only after durable exact intent acknowledgment and ignores an identical duplicate', async () => {
    const f = fixture(); const admitted = f.client.admit('a'); const done = vi.fn(); void admitted.then(done);
    await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    f.writer.record({ kind: 'email', value: email }); const ack = acknowledge(f);
    expect(await admitted).toBe(email); f.channel.emit('message', ack); expect(f.review).not.toHaveBeenCalled();
    f.client.close(); expect(f.channel.eventNames()).toEqual([]); await expect(f.client.admit('b')).rejects.toThrow('closed');
  });
  it('validates a historical receipt prefix when subsequent token allocations already appended', async () => {
    const f = fixture(); const admitted = f.client.admit('a'); f.writer.record({ kind: 'email', value: email });
    const receipt = readJournalSnapshot(f.journal, owner); f.writer.record({ kind: 'tokenHash', value: hash });
    acknowledge(f, { sequence: receipt.sequence, digest: receipt.digest }); expect(await admitted).toBe(email); f.client.close();
  });
  it.each(['wrong-owner', 'digest', 'missing-intent', 'sequence', 'unknown-id', 'extra-secret'])('rejects %s receipt', async (kind) => {
    const f = fixture(); const pending = f.client.admit('a'); const rejected = expect(pending).rejects.toThrow(/^Fixture intent requires review\.$/);
    if (kind !== 'missing-intent') f.writer.record({ kind: 'email', value: email });
    const patch = kind === 'wrong-owner' ? { runId: owner.testId } : kind === 'digest' ? { digest: hash }
      : kind === 'sequence' ? { sequence: 999 } : kind === 'unknown-id' ? { messageId: owner.runId }
      : kind === 'extra-secret' ? { cookie: 'never stored' } : {};
    acknowledge(f, patch); await rejected; expect(f.review).toHaveBeenCalledOnce(); expect(f.channel.eventNames()).toEqual([]);
  });
  it.each(['synchronous', 'callback', 'timeout', 'disconnect', 'close'])('rejects %s channel interruption without retry', async (kind) => {
    vi.useFakeTimers(); const f = fixture();
    if (kind === 'synchronous') f.send.mockImplementation(() => { throw new Error('private'); });
    if (kind === 'callback') f.send.mockImplementation((_message, callback) => { queueMicrotask(() => callback(new Error('private'))); });
    const pending = f.client.admit('a'); const failure = expect(pending).rejects.toThrow('review');
    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(11);
    if (kind === 'disconnect') f.channel.emit('disconnect');
    if (kind === 'close') f.client.close();
    await failure; expect(f.send).toHaveBeenCalledOnce(); expect(f.review).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('integrates the parent/child protocol with asynchronous injected delivery only', async () => {
    const journal = memoryIo(); const channel = new EventEmitter(); const review = vi.fn();
    const writer = createChildRecorder(owner, journal, async (ack: Acknowledgment) => { channel.emit('message', ack); }, review);
    const client = createIntentClient(owner, journal, channel, (message, callback) => {
      void writer.intent(message).then(() => callback(null), () => callback(new Error('delivery failed')));
    }, review);
    expect(await client.admit('a')).toBe(email); writer.assertIntent(email);
    client.close(); await writer.seal(async () => undefined); expect(review).not.toHaveBeenCalled();
  });
});
