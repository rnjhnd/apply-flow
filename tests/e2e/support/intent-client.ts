import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Owner } from './ownership.js';
import { canonicalOwner, ownedEmail } from './ownership.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';
import { digest } from './schema.js';

const ack = z.strictObject({ type: z.literal('intent-ack'), runId: z.uuid(), testId: z.uuid(), messageId: z.uuid(),
  sequence: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type Intent = { type: 'email-intent'; runId: string; testId: string; messageId: string; email: string };
// Parent-side receipt checking. No browser/fixture request is authorized until
// its exact email intent is durably present and this owned channel acknowledges.
export function createIntentClient(owner: Owner, journal: JournalIo, child: Pick<EventEmitter, 'on' | 'off'>,
  send: (message: Intent, callback: (error: Error | null) => void) => void, onReview: () => void, timeoutMs = 2000) {
  owner = canonicalOwner(owner);
  const pending = new Map<string, { email: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const completed = new Map<string, string>();
  let closed = false;
  function fail() {
    if (closed) return; closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Fixture intent requires review.')); }
    pending.clear(); child.off('message', onMessage); child.off('disconnect', fail); child.off('error', fail);
    onReview();
  }
  function onMessage(input: unknown) {
    if (typeof input !== 'object' || input === null || !('type' in input) || input.type !== 'intent-ack' || closed) return;
    try {
      const value = ack.parse(input);
      if (value.runId !== owner.runId || value.testId !== owner.testId) throw new Error();
      const serialized = JSON.stringify(value);
      if (completed.get(value.messageId) === serialized) return;
      const item = pending.get(value.messageId);
      if (!item) throw new Error();
      const contents = journal.read();
      const snapshot = readJournalSnapshot({ read: () => contents, append: () => { throw new Error(); } }, owner);
      const prefix = `${contents.trimEnd().split('\n').slice(0, value.sequence + 1).join('\n')}\n`;
      const acknowledged = readJournalSnapshot({ read: () => prefix, append: () => { throw new Error(); } }, owner);
      if (snapshot.journal.state !== 'running' || value.sequence > snapshot.sequence || value.sequence !== acknowledged.sequence || digest(prefix) !== value.digest
        || !acknowledged.journal.events.some((event) => event.kind === 'email' && event.value === item.email)) throw new Error();
      clearTimeout(item.timer); pending.delete(value.messageId); completed.set(value.messageId, serialized); item.resolve();
    } catch { fail(); }
  }
  child.on('message', onMessage); child.on('disconnect', fail); child.on('error', fail);
  return {
    admit(suffix: string): Promise<string> {
      if (closed || pending.size + completed.size >= 10_000) return Promise.reject(new Error('Fixture intent is closed.'));
      const email = ownedEmail(owner, suffix); const messageId = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(fail, timeoutMs);
        pending.set(messageId, { email, resolve, reject, timer });
        try { send({ type: 'email-intent', runId: owner.runId, testId: owner.testId, messageId, email }, (error) => { if (error) fail(); }); }
        catch { fail(); }
      }).then(() => email);
    },
    close() {
      if (pending.size) { fail(); return; }
      closed = true; child.off('message', onMessage); child.off('disconnect', fail); child.off('error', fail);
    }
  };
}
