import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { createSessionService } from '../../../apps/api/src/modules/auth/sessions.js';
import type { AuthenticationService } from '../../../apps/api/src/modules/auth/authentication.js';
import type { createGuardedTransactions } from './guarded-database.js';
import { canonicalOwner, recordingTokenFactory, type Owner } from './ownership.js';
import { createChildRecorder } from './child-protocol.js';
import { createFinalizer } from './finalization.js';
import { ownChild, type OwnedChild } from './lifecycle.js';
import type { JournalIo } from './journal.js';
import type { acquireLease } from './safety-io.js';
import { createIntentClient, type Intent } from './intent-client.js';

// Test composition only. All admitted work, including standalone anonymous
// allocation, settles its guarded transaction before its caller receives data.
// There is intentionally no runtime session-expiration cleanup method.
export function composeServices(database: ReturnType<typeof createGuardedTransactions>,
  recorder: ReturnType<typeof createChildRecorder>,
  buildAuthentication: (token: () => string) => AuthenticationService, now: () => Date) {
  const token = recordingTokenFactory(recorder.record);
  const authentication = buildAuthentication(token);
  return {
    token,
    sessions: {
      findValid: (value: string) => recorder.request(() => database.$transaction((tx) => createSessionService(tx, { token, now }).findValid(value))),
      createAnonymous: () => recorder.request(() => database.$transaction((tx) => createSessionService(tx, { token, now }).createAnonymous()))
    },
    authentication: {
      register: (...args: Parameters<AuthenticationService['register']>) => {
        recorder.assertIntent(args[0].email);
        return recorder.request(() => authentication.register(...args));
      },
      login: (...args: Parameters<AuthenticationService['login']>) => recorder.request(() => authentication.login(...args)),
      me: (...args: Parameters<AuthenticationService['me']>) => recorder.request(() => authentication.me(...args)),
      logout: (...args: Parameters<AuthenticationService['logout']>) => recorder.request(() => authentication.logout(...args))
    }
  };
}

type ChannelChild = Omit<OwnedChild, 'send'> & {
  send(message: { type: 'shutdown'; runId: string } | Intent, callback: (error: Error | null) => void): void;
};
const sealedMessage = z.strictObject({ type: z.literal('child-sealed'), runId: z.uuid(), testId: z.uuid(),
  sequence: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const closureMessage = z.strictObject({ type: z.literal('channel-closing'), runId: z.uuid(), testId: z.uuid() });

// No spawn default, PID lookup, server URL, or existing-server reuse. The
// injected handle is shared by lifecycle control and parent exit observation.
export function composeParent(owner: Owner, journal: JournalIo, ledger: JournalIo,
  lease: ReturnType<typeof acquireLease>, spawn: () => ChannelChild,
  timing?: { startupMs: number; graceMs: number; exitMs: number }) {
  owner = canonicalOwner(owner);
  // Persist admission evidence before spawning. The private relay forwards
  // only actual events from the returned owned child, never IPC exit claims.
  const observed = new EventEmitter();
  const finalizer = createFinalizer(owner, journal, ledger, lease, observed);
  let child: ChannelChild;
  try { child = spawn(); }
  catch { finalizer.review(); finalizer.detach(); throw new Error('Owned child creation requires review.'); }
  const onExit = (code: number | null, signal: string | null) => observed.emit('exit', code, signal);
  const onDisconnect = () => observed.emit('disconnect');
  const onError = () => observed.emit('error');
  child.on('exit', onExit); child.on('disconnect', onDisconnect); child.on('error', onError);
  const failed = () => { finalizer.review(); void lifecycle.stop().catch(() => undefined); };
  const onMessage = (input: unknown) => {
    if (typeof input !== 'object' || input === null || !('type' in input)
      || (input.type !== 'child-sealed' && input.type !== 'channel-closing')) return;
    const parsed = z.discriminatedUnion('type', [sealedMessage, closureMessage]).safeParse(input);
    if (!parsed.success || parsed.data.runId !== owner.runId || parsed.data.testId !== owner.testId) { failed(); return; }
    try {
      if (parsed.data.type === 'child-sealed') finalizer.acceptSeal(parsed.data);
      else finalizer.expectChannelClosure();
    } catch { failed(); }
  };
  child.on('message', onMessage);
  const lifecycle = ownChild(() => ({ on: child.on.bind(child), off: child.off.bind(child),
    send(message) {
      try { child.send(message, (error) => { if (error) failed(); }); }
      catch { failed(); throw new Error('Owned shutdown channel failed.'); }
    },
    kill() { finalizer.review(); child.kill(); }
  }), owner.runId, timing);
  const managed = lifecycle;
  const intents = createIntentClient(owner, journal, child, child.send.bind(child), failed);
  let stopping: Promise<void> | undefined;
  return {
    ready: managed.ready, isHealthy: managed.isHealthy, finalizer, intents,
    stop() {
      intents.close();
      if (finalizer.phase() === 'recording') {
        try { finalizer.quiesce(); } catch { finalizer.review(); }
      }
      stopping ??= managed.stop().finally(() => {
        child.off('message', onMessage); child.off('exit', onExit);
        child.off('disconnect', onDisconnect); child.off('error', onError); finalizer.detach();
      });
      return stopping;
    }
  };
}
