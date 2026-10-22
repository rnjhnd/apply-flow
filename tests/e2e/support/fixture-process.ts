import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions } from 'node:child_process';
import { z } from 'zod';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { admitEnvironment, childEnvironment } from './environment.js';
import { approvedChecksum } from './database-preflight.js';
import { digest } from './schema.js';
import { canonicalOwner, type Owner } from './ownership.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';
import type { acquireLease } from './safety-io.js';
import { createFinalizer } from './finalization.js';
import { createIntentClient } from './intent-client.js';
import { readOperationLedger } from './fixture-evidence.js';

export const fixtureChildEntry = fileURLToPath(new URL('./fixture-child.ts', import.meta.url));
const control = z.strictObject({ type: z.enum(['journal-ready', 'child-sealed', 'channel-closing', 'cycle-complete']),
  runId: z.uuid(), testId: z.uuid(), sequence: z.number().int().nonnegative().optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const reviewNotice = z.strictObject({ type: z.literal('review-required'), runId: z.uuid(), testId: z.uuid() });
export type FixtureChildHandle = EventEmitter & {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  send(message: unknown, callback: (error: Error | null) => void): void;
  kill(): void;
};
export type FixtureSpawn = (spec: Readonly<{ entry: string; environment: Record<string, string>; shell: false; windowsHide: true }>) => FixtureChildHandle;
type Lease = ReturnType<typeof acquireLease>;

// Fixed OS composition, still requiring injected spawn and a disabled child
// entry. Never inherit stdio (driver errors/stacks) or accept caller executables.
export function createFixtureSpawn(spawnProcess: (executable: string, args: string[], options: SpawnOptions) => FixtureChildHandle): FixtureSpawn {
  return (spec) => {
    if (spec.entry !== fixtureChildEntry || spec.shell !== false || spec.windowsHide !== true) throw new Error('Fixture process target rejected.');
    const environment = childEnvironment(spec.environment);
    return spawnProcess(process.execPath, ['--import', 'tsx', fixtureChildEntry], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: environment,
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
  };
}

// Mandatory injected spawn/preflight. No real process implementation/default is
// installed in B3B. Child owns the journal; parent never pre-creates it.
export async function startFixtureParent(source: DatabaseEnvironment, migration: Uint8Array, owner: Owner,
  files: { journal: JournalIo; ledger: JournalIo; operations: JournalIo }, leases: { run: Lease; finalizer: Lease },
  dependencies: { preflight(): Promise<void>; spawn: FixtureSpawn },
  timing = { startup: 30_000, work: 60_000, grace: 20_000, exit: 2000, ipc: 2000 }) {
  owner = canonicalOwner(owner); admitEnvironment(source);
  if (digest(migration) !== approvedChecksum) throw new Error('Unapproved fixture migration.');
  leases.run.assertFor(owner, 'run'); leases.finalizer.assertFor(owner, 'finalizer');
  await dependencies.preflight();
  admitEnvironment(source); leases.run.assertHeld(); leases.finalizer.assertHeld();
  const child = dependencies.spawn(Object.freeze({ entry: fixtureChildEntry, environment: childEnvironment(source), shell: false, windowsHide: true }));
  const observed = new EventEmitter();
  let finalizer: ReturnType<typeof createFinalizer> | undefined; let intents: ReturnType<typeof createIntentClient> | undefined;
  let failed = false; let stopping = false; let exited = false; let complete = false; let started = false;
  let operationDigest: string | undefined; let stopPromise: Promise<void> | undefined;
  let released = false;
  let resolveExit!: () => void; const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let readyResolve!: () => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => undefined);
  let resultResolve!: () => void; let resultReject!: (error: Error) => void;
  const result = new Promise<void>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  void result.catch(() => undefined);
  function review() {
    if (failed) return;
    failed = true; finalizer?.review(); intents?.close();
    readyReject(new Error('Fixture child requires review.')); resultReject(new Error('Fixture child requires review.'));
  }
  async function bounded<T>(promise: Promise<T>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture process deadline exceeded.')), ms);
    })]); } finally { clearTimeout(timer); }
  }
  async function send(type: string, extra: Record<string, string | number> = {}) {
    try { await bounded(new Promise<void>((resolve, reject) => {
      child.send({ type, runId: owner.runId, testId: owner.testId, ...extra }, (error) => error ? reject(new Error()) : resolve());
    }), timing.ipc); } catch { review(); throw new Error('Fixture IPC requires review.'); }
  }
  const authorityLease: Lease = { ...leases.finalizer,
    assertHeld() {
      leases.run.assertHeld(); leases.finalizer.assertHeld();
      if (failed) throw new Error('Fixture authority unavailable.');
      if (operationDigest && readOperationLedger(owner, files.operations, files.journal).digest !== operationDigest) throw new Error('Fixture operation evidence changed.');
    }
  };
  const onExit = (code: number | null, signal: string | null) => {
    // Validate the observed event against the owned handle before forwarding
    // anything to the finalizer. Missing/conflicting/duplicate evidence fails.
    if (exited || code !== 0 || signal !== null || child.exitCode !== code || child.signalCode !== signal) review();
    exited = true; resolveExit();
    if (!finalizer) review(); else if (!failed) observed.emit('exit', code, signal);
    if (finalizer?.phase() !== 'exit-confirmed') review();
  };
  const onDisconnect = () => { if (!finalizer) review(); else { observed.emit('disconnect'); if (finalizer.phase() === 'review-required') review(); } };
  const onError = () => { review(); };
  let messages = Promise.resolve();
  const onMessage = (input: unknown) => {
    if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'review-required') {
      // Latch before queued continuations or a subsequent normal exit event.
      try {
        const notice = reviewNotice.parse(input);
        if (notice.runId !== owner.runId || notice.testId !== owner.testId) throw new Error();
      } catch { /* Malformed review evidence also fails closed. */ }
      review(); return;
    }
    if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'intent-ack') return;
    messages = messages.then(async () => {
      if (failed) return;
      const message = control.parse(input);
      if (message.runId !== owner.runId || message.testId !== owner.testId) throw new Error();
      if (message.type === 'journal-ready') {
        if (finalizer || stopping || exited) throw new Error();
        const snapshot = readJournalSnapshot(files.journal, owner);
        if (snapshot.sequence !== 0 || snapshot.journal.state !== 'running' || snapshot.journal.events.length !== 0
          || message.sequence !== 0 || message.digest !== snapshot.digest) throw new Error();
        finalizer = createFinalizer(owner, files.journal, files.ledger, authorityLease, observed);
        intents = createIntentClient(owner, files.journal, child, child.send.bind(child), review, timing.ipc);
        await send('parent-admitted', { digest: snapshot.digest });
        if (failed || exited || stopping) throw new Error(); readyResolve();
      } else if (message.type === 'cycle-complete') {
        if (!started || complete || stopping || !readOperationLedger(owner, files.operations, files.journal).settled) throw new Error();
        complete = true; resultResolve();
      } else if (message.type === 'child-sealed') {
        if (!stopping || !complete || !finalizer || message.sequence === undefined || !message.digest) throw new Error();
        const operations = readOperationLedger(owner, files.operations, files.journal);
        if (!operations.settled || message.operationDigest !== operations.digest) throw new Error();
        operationDigest = operations.digest;
        finalizer.acceptSeal({ sequence: message.sequence, digest: message.digest });
        await send('seal-ack', { digest: message.digest });
      } else {
        if (!finalizer || finalizer.phase() !== 'child-sealed') throw new Error();
        finalizer.expectChannelClosure(); await send('closure-ack');
      }
    }).catch(() => { review(); });
  };
  child.on('message', onMessage); child.on('exit', onExit); child.on('disconnect', onDisconnect); child.on('error', onError);
  async function waitExit(ms: number) { try { await bounded(exit, ms); return true; } catch { return exited; } }
  function detach() {
    intents?.close(); finalizer?.detach(); child.off('message', onMessage); child.off('exit', onExit);
    child.off('disconnect', onDisconnect); child.off('error', onError);
  }
  function stop() {
    stopping = true; intents?.close();
    if (finalizer?.phase() === 'recording') finalizer.quiesce();
    stopPromise ??= Promise.resolve().then(async () => {
      if (!exited) { try { await send('shutdown'); } catch { review(); } }
      if (!await waitExit(timing.grace) && !exited) {
        review(); try { child.kill(); } catch { /* Only this owned handle; never cleanup eligibility. */ }
        if (!await waitExit(timing.exit)) throw new Error('Fixture child exit unconfirmed.');
      }
      await messages;
      if (failed || finalizer?.phase() !== 'exit-confirmed') throw new Error('Fixture child shutdown requires review.');
    }).finally(detach);
    return stopPromise;
  }
  try { await send('initialize'); await bounded(ready, timing.startup); }
  catch { review(); try { await stop(); } catch { /* Retain evidence. */ } throw new Error('Fixture startup requires review.'); }
  return Object.freeze({
    async run() {
      if (failed || stopping || started || !intents) throw new Error('Fixture operation is not admitted.');
      started = true;
      try { await intents.admit('a'); await send('run-cycle'); await bounded(result, timing.work); }
      catch { review(); throw new Error('Fixture execution requires review.'); }
    },
    stop,
    finalizer() { if (failed || !exited || finalizer?.phase() !== 'exit-confirmed') throw new Error('Fixture finalization is not admitted.'); return finalizer; },
    review,
    release() {
      if (released) return;
      if (failed || !exited || finalizer?.phase() !== 'cleaned') throw new Error('Fixture leases are not releasable.');
      authorityLease.assertHeld();
      try { leases.finalizer.release(); leases.run.release(); released = true; }
      catch { review(); throw new Error('Fixture lease release requires review.'); }
    },
    isHealthy: () => !failed && !stopping && !exited
  });
}
