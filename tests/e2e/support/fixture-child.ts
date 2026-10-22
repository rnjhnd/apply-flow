import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';
import { z } from 'zod';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';
import { canonicalOwner, type Owner } from './ownership.js';
import { createChildRecorder } from './child-protocol.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';
import { createOperationLedger } from './fixture-evidence.js';
import type { openFixtureDatabase } from './fixture-database.js';

const message = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['initialize', 'run-cycle', 'shutdown', 'closure-ack']), runId: z.uuid(), testId: z.uuid() }),
  z.strictObject({ type: z.enum(['parent-admitted', 'seal-ack']), runId: z.uuid(), testId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ type: z.literal('email-intent'), runId: z.uuid(), testId: z.uuid(), messageId: z.uuid(), email: z.email() })
]);
type Connection = Awaited<ReturnType<typeof openFixtureDatabase>>;
type ExitPort = { exitCode: string | number | undefined; on(event: 'exit', listener: () => void): unknown; exit(code: number): void };
export type FixtureExitHost = Readonly<{ failureLatched(): boolean }>;
const exitHosts = new WeakMap<FixtureExitHost, { claimed: boolean; fail(): void; complete(): void }>();
const ownedExitPorts = new WeakSet<ExitPort>();

// Explicit injected owned-process capability, never installed on import or by
// the disabled entry. A future runtime must pass its actual process here. Keep
// the exit listener for that process's lifetime, including natural termination.
export function createFixtureExitHost(port: ExitPort): FixtureExitHost {
  if (ownedExitPorts.has(port)) throw new Error('Fixture exit host already owned.');
  let failed = false;
  const enforceFailure = () => { if (failed) port.exitCode = 1; };
  try {
    // Premature natural exit is failure until the sole successful shutdown path.
    port.exitCode = 1;
    if (port.exitCode !== 1) throw new Error();
    port.on('exit', enforceFailure);
  } catch { throw new Error('Fixture exit host unavailable.'); }
  ownedExitPorts.add(port);
  const host = Object.freeze({ failureLatched: () => failed });
  exitHosts.set(host, {
    claimed: false,
    fail() { failed = true; enforceFailure(); },
    complete() {
      if (failed) throw new Error('Fixture successful exit unavailable.');
      port.exitCode = 0;
      if (failed || port.exitCode !== 0) throw new Error('Fixture successful exit unavailable.');
      port.exit(0);
      // Real Node exit does not return; injected hosts may do so after listeners.
      if (failed) throw new Error('Fixture successful exit unavailable.');
    }
  });
  return host;
}

// Headless service-only composition. All process/filesystem/database operations
// are injected. Importing or invoking the file cannot install a live runtime.
export function createFixtureChild(source: DatabaseEnvironment, owner: Owner,
  files: { journal: JournalIo; operations: JournalIo }, dependencies: {
    send(message: unknown): Promise<void>; connect(signal: AbortSignal): Promise<Connection>;
    disconnect(): void; exitHost: FixtureExitHost; review(): void;
  }, acknowledgmentMs = 2000) {
  admitEnvironment(source); owner = canonicalOwner(owner);
  const suppliedExitHost = exitHosts.get(dependencies.exitHost);
  if (!suppliedExitHost || suppliedExitHost.claimed || dependencies.exitHost.failureLatched()) throw new Error('Fixture exit host unavailable.');
  const exitHost = suppliedExitHost;
  exitHost.claimed = true;
  const controller = new AbortController();
  let state: 'new' | 'awaiting-parent' | 'ready' | 'running' | 'complete' | 'stopping' | 'sealed' | 'closed' | 'review' = 'new';
  let recorder: ReturnType<typeof createChildRecorder> | undefined;
  let ledger: ReturnType<typeof createOperationLedger> | undefined;
  let connection: Connection | undefined; let active: Promise<unknown> | undefined;
  let email: string | undefined; let sealDigest: string | undefined;
  let generation = 0;
  const waits = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  function review() {
    if (state === 'review') return;
    state = 'review'; generation++;
    // Synchronous failure status precedes abort callbacks, persistence and IPC.
    exitHost.fail(); controller.abort();
    try { dependencies.review(); } catch { /* Keep review terminal even if reporting fails. */ }
    for (const waiter of waits.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Fixture acknowledgment requires review.')); }
    waits.clear();
    // Fixed, secret-free evidence. Failure to deliver never permits a clean exit.
    void send({ type: 'review-required', runId: owner.runId, testId: owner.testId }).catch(() => undefined);
  }
  function assertShutdown(expected: 'stopping' | 'sealed' | 'closed', authority: number) {
    if (controller.signal.aborted || generation !== authority || state !== expected) throw new Error('Fixture shutdown authority changed.');
  }
  function waiting(type: string) {
    return new Promise<void>((resolve, reject) => {
      if (waits.has(type)) { reject(new Error('Duplicate fixture waiter.')); return; }
      waits.set(type, { resolve, reject, timer: setTimeout(() => { review(); }, acknowledgmentMs) });
    });
  }
  async function send(input: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([dependencies.send(input), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { review(); reject(new Error()); }, acknowledgmentMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function receive(input: unknown): Promise<void> {
    try {
      if (state === 'review' || state === 'closed') throw new Error();
      const value = message.parse(input);
      if (value.runId !== owner.runId || value.testId !== owner.testId) throw new Error();
      if (value.type === 'initialize') {
        if (state !== 'new') throw new Error();
        recorder = createChildRecorder(owner, files.journal, send, review);
        ledger = createOperationLedger(owner, files.operations, files.journal, review);
        state = 'awaiting-parent';
        const snapshot = readJournalSnapshot(files.journal, owner);
        await send({ type: 'journal-ready', runId: owner.runId, testId: owner.testId, sequence: 0, digest: snapshot.digest });
      } else if (value.type === 'parent-admitted') {
        if (state !== 'awaiting-parent' || value.digest !== readJournalSnapshot(files.journal, owner).digest) throw new Error();
        state = 'ready';
      } else if (value.type === 'email-intent') {
        if (state !== 'ready' || email) throw new Error();
        email = value.email;
        await recorder!.intent(value);
        // Parent may act on the durable ack before its send promise returns.
        // An already admitted run is not a late/invalid intent continuation.
        if (controller.signal.aborted) throw new Error();
      } else if (value.type === 'run-cycle') {
        if (state !== 'ready' || !email || active) throw new Error();
        state = 'running'; const exactEmail = email;
        active = (async () => {
          connection = await dependencies.connect(controller.signal);
          if (controller.signal.aborted) throw new Error();
          await connection.cycle(exactEmail, recorder!, ledger!);
          if (controller.signal.aborted) throw new Error();
          // Quiescence can already be waiting. Do not reopen operation admission.
          if (state === 'running') state = 'complete';
          await send({ type: 'cycle-complete', runId: owner.runId, testId: owner.testId });
        })();
        await active;
      } else if (value.type === 'shutdown') {
        if (!active || (state !== 'running' && state !== 'complete')) throw new Error();
        state = 'stopping';
        const authority = generation;
        await active;
        assertShutdown('stopping', authority);
        const seal = await recorder!.seal(async () => {
          assertShutdown('stopping', authority); ledger!.assertSettled(); await connection!.close();
          assertShutdown('stopping', authority);
        });
        assertShutdown('stopping', authority);
        if (!connection!.isClosed()) throw new Error();
        sealDigest = seal.digest; state = 'sealed';
        const ack = waiting('seal-ack'); void ack.catch(() => undefined);
        await send({ type: 'child-sealed', runId: owner.runId, testId: owner.testId, sequence: seal.sequence,
          digest: seal.digest, operationDigest: ledger!.snapshot().digest });
        assertShutdown('sealed', authority);
        await ack;
        assertShutdown('sealed', authority);
        const closingAck = waiting('closure-ack'); void closingAck.catch(() => undefined);
        await send({ type: 'channel-closing', runId: owner.runId, testId: owner.testId });
        assertShutdown('sealed', authority);
        await closingAck;
        assertShutdown('sealed', authority);
        state = 'closed';
        assertShutdown('closed', authority); dependencies.disconnect();
        assertShutdown('closed', authority); exitHost.complete();
      } else {
        if (state !== 'sealed' || (value.type === 'seal-ack' && value.digest !== sealDigest)) throw new Error();
        const waiter = waits.get(value.type); if (!waiter) throw new Error();
        clearTimeout(waiter.timer); waits.delete(value.type); waiter.resolve();
      }
    } catch { review(); throw new Error('Fixture child requires review.'); }
  }
  return Object.freeze({ receive, interrupt: review, state: () => state });
}

// This direct entry cannot be activated by flags or valid test environment.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { writeSync(2, 'APPLYFLOW_FIXTURES DISABLED: Live fixture child execution requires separate approval.\n'); } catch { /* No raw fallback. */ }
  process.exitCode = 1;
}
