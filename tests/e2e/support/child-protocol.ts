import { z } from 'zod';
import { createJournal, type JournalIo } from './journal.js';
import { canonicalOwner, type Owner } from './ownership.js';
import { digest } from './schema.js';
import { AuthHttpError } from '../../../apps/api/src/modules/auth/http-error.js';

const intent = z.strictObject({ type: z.literal('email-intent'), runId: z.uuid(), testId: z.uuid(), messageId: z.uuid(), email: z.email() });
export type Acknowledgment = { type: 'intent-ack'; runId: string; testId: string; messageId: string; sequence: number; digest: string };

// The child's sole writer. The channel transports only validated email intents
// and non-secret receipts. Token allocation still uses recordingTokenFactory.
export function createChildRecorder(owner: Owner, io: JournalIo,
  send: (ack: Acknowledgment) => Promise<void>, onReview: () => void) {
  owner = canonicalOwner(owner);
  const journal = createJournal(io, owner);
  let state: 'recording' | 'quiescing' | 'sealed' | 'review' = 'recording';
  let active = 0;
  let wake: (() => void) | undefined;
  let queue = Promise.resolve();
  const acknowledgments = new Map<string, { fingerprint: string; ack: Acknowledgment }>();
  const admittedEmails = new Set<string>();
  const review = () => { state = 'review'; onReview(); };
  const record = (event: Parameters<typeof journal.record>[0]) => {
    if (state !== 'recording' && !(state === 'quiescing' && active > 0)) throw new Error('Fixture allocation is closed.');
    try { journal.record(event); } catch { review(); throw new Error('Fixture evidence requires review.'); }
  };
  return {
    record,
    intent(input: unknown): Promise<void> {
      // Admission happens synchronously, not after a queued quiesce.
      if (state !== 'recording' || acknowledgments.size >= 10_000) return Promise.reject(new Error('Fixture intent is not admitted.'));
      const operation = queue.then(async () => {
        try {
          if (state !== 'recording') throw new Error('Late fixture intent.');
          const message = intent.parse(input);
          if (message.runId !== owner.runId || message.testId !== owner.testId) throw new Error('Wrong intent owner.');
          const fingerprint = digest(JSON.stringify(message));
          const old = acknowledgments.get(message.messageId);
          if (old && old.fingerprint !== fingerprint) throw new Error('Conflicting IPC message.');
          if (old) { await send(old.ack); return; }
          record({ kind: 'email', value: message.email });
          const contents = io.read();
          const ack: Acknowledgment = { type: 'intent-ack', runId: owner.runId, testId: owner.testId, messageId: message.messageId,
            sequence: contents.trimEnd().split('\n').length - 1, digest: digest(contents) };
          acknowledgments.set(message.messageId, { fingerprint, ack });
          admittedEmails.add(message.email);
          await send(ack); // durable recording precedes acknowledgment
        } catch { review(); throw new Error('Fixture acknowledgment requires review.'); }
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    assertIntent(email: string) {
      if (state !== 'recording' || !admittedEmails.has(email)) throw new Error('Acknowledged fixture intent is required.');
    },
    async request<T>(work: () => Promise<T>): Promise<T> {
      if (state !== 'recording') throw new Error('Fixture requests are closed.');
      active++;
      try { return await work(); }
      catch (error) {
        // Expected admission/authentication rejections settle normally. Unknown
        // failures or storage 5xx may conceal an ambiguous database outcome.
        if (!(error instanceof AuthHttpError) || error.status >= 500) review();
        throw error;
      }
      finally { active--; if (active === 0) wake?.(); }
    },
    async seal(closeDatabase: () => Promise<void>) {
      if (state !== 'recording') throw new Error('Child sealing is not admitted.');
      state = 'quiescing';
      try {
        await queue;
        if (active) await new Promise<void>((resolve) => { wake = resolve; });
        if (state !== 'quiescing') throw new Error('Unsettled child evidence.');
        await closeDatabase();
        if (state !== 'quiescing') throw new Error('Unsettled child evidence.');
        const seal = journal.sealForHandoff();
        state = 'sealed';
        return { sequence: seal.sequence, digest: seal.digest };
      } catch { review(); throw new Error('Child sealing requires review.'); }
    },
    state: () => state
  };
}
