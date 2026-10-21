import { z } from 'zod';
import type { EventEmitter } from 'node:events';
import { canonicalOwner, parseJournal, type Owner } from './ownership.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';
import { durableAppend, type acquireLease } from './safety-io.js';
import { digest } from './schema.js';
import type { createGuardedTransactions } from './guarded-database.js';
import { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';

export type Phase = 'recording' | 'quiescing' | 'child-sealed' | 'exit-confirmed' | 'finalizing' | 'cleanup-eligible' | 'cleaned' | 'review-required';
const phases: Phase[] = ['recording', 'quiescing', 'child-sealed', 'exit-confirmed', 'finalizing', 'cleanup-eligible', 'cleaned'];
const row = z.strictObject({ id: z.uuid().transform((id) => id.toLowerCase()), email: z.email().max(254) });
export type OwnedUser = z.infer<typeof row>;
export type Seal = { sequence: number; digest: string };
type Lease = ReturnType<typeof acquireLease>;
export type CleanupPermit = { readonly ownership: 'parent-finalized' };
type Authority = { owner: Owner; io: JournalIo; seal: Seal; users: OwnedUser[]; hashes: string[];
  phase(): Phase; transition(phase: Phase): void; assert(): void; assertLive(): void; review(): void; pending: boolean };
const permits = new WeakMap<CleanupPermit, Authority>();
const finalizerLeases = new WeakSet<Lease>();

export async function resolveIntentUsers(tx: Prisma.TransactionClient, emails: readonly string[]): Promise<unknown> {
  if (!emails.length) return [];
  return tx.$queryRaw(Prisma.sql`SELECT id, email FROM public."User" WHERE email IN (${Prisma.join([...emails])}) ORDER BY id FOR KEY SHARE`);
}

// This coordinator owns the injected child's exit listener. IPC messages never
// attest exit. A fresh coordinator cannot reopen an existing ledger (wx).
export function createFinalizer(owner: Owner, journalIo: JournalIo, ledgerIo: JournalIo,
  lease: Lease, child: Pick<EventEmitter, 'on' | 'off'>) {
  owner = canonicalOwner(owner);
  lease.assertFor(owner, 'finalizer');
  if (readJournalSnapshot(journalIo, owner).journal.state !== 'running') throw new Error('Terminal ownership cannot be reopened.');
  if (finalizerLeases.has(lease)) throw new Error('Finalizer lease is already assigned.');
  finalizerLeases.add(lease);
  let phase: Phase = 'recording';
  let sequence = -1;
  let previousDigest: string | null = null;
  let ledgerContents = '';
  let seal: Seal | null = null;
  let pending = false;
  let generation = 0;
  let writingLedger = false;
  let controlledClosure = false;
  let permit: CleanupPermit | undefined;
  function persist(next: Phase) {
    if (writingLedger) throw new Error('Concurrent ledger write.');
    const expectedPhase = phase; const expectedGeneration = generation;
    writingLedger = true;
    try {
      lease.assertHeld();
      if (sequence >= 0 && ledgerIo.read() !== ledgerContents) throw new Error('Finalization ledger changed.');
      assertPhase(expectedPhase, expectedGeneration);
      const entry = { version: 1, runId: owner.runId, testId: owner.testId,
        sequence: sequence + 1, phase: next, previousDigest, seal };
      const line = `${JSON.stringify(entry)}\n`;
      durableAppend(ledgerIo, entry, sequence < 0);
      ledgerContents += line;
      previousDigest = digest(line); sequence++;
      assertPhase(expectedPhase, expectedGeneration);
    } finally {
      writingLedger = false;
      // A synchronous I/O fault hook may request review inside append. Record
      // it afterward, without reentrant appends or restoring the old phase.
      if (phase === 'review-required' && next !== 'review-required') persistReview();
    }
  }
  function persistReview() {
    try { persist('review-required'); } catch { /* Retain partial/failed evidence. */ }
  }
  function review() {
    if (phase === 'review-required') return;
    phase = 'review-required';
    generation++;
    // Even if evidence storage fails, this instance stays permanently closed.
    if (!writingLedger) persistReview();
  }
  function assertPhase(expected: Phase, expectedGeneration: number) {
    if (phase !== expected || generation !== expectedGeneration) throw new Error('Finalization authority changed.');
  }
  function assertEvidence() {
    lease.assertHeld();
    if (ledgerIo.read() !== ledgerContents) throw new Error('Finalization ledger changed.');
    if (seal) {
      const current = readJournalSnapshot(journalIo, owner);
      if (current.sequence !== seal.sequence || current.digest !== seal.digest) throw new Error('Ownership digest changed.');
    }
  }
  function assertCurrent(expected: Phase, expectedGeneration: number) {
    assertPhase(expected, expectedGeneration); assertEvidence(); assertPhase(expected, expectedGeneration);
  }
  function transition(next: Phase, expectedGeneration = generation) {
    try {
      const previous = phase;
      if (phases.indexOf(next) !== phases.indexOf(phase) + 1 || phase === 'review-required') throw new Error('Invalid finalization transition.');
      assertCurrent(previous, expectedGeneration); persist(next); assertCurrent(previous, expectedGeneration); phase = next;
    } catch { review(); throw new Error('Finalization requires review.'); }
  }
  persist('recording');
  const onExit = (code: number | null, signal: string | null) => {
    if (phase === 'child-sealed' && code === 0 && signal === null) {
      try { transition('exit-confirmed'); } catch { review(); }
    } else review();
  };
  const onDisconnect = () => {
    if (['exit-confirmed', 'finalizing', 'cleanup-eligible', 'cleaned'].includes(phase)) return;
    if (phase === 'child-sealed' && controlledClosure) {
      try { assertCurrent('child-sealed', generation); } catch { review(); }
      return;
    }
    review();
  };
  const onError = () => review();
  child.on('exit', onExit); child.on('error', onError); child.on('disconnect', onDisconnect);
  return {
    phase: () => phase,
    quiesce: () => transition('quiescing'),
    expectChannelClosure() {
      try { assertCurrent('child-sealed', generation); controlledClosure = true; }
      catch { review(); throw new Error('Channel closure requires review.'); }
    },
    acceptSeal(value: Seal) {
      try {
        if (phase !== 'quiescing') throw new Error('Unexpected seal.');
        const current = readJournalSnapshot(journalIo, owner);
        if (current.journal.state !== 'running' || current.sequence !== value.sequence || current.digest !== value.digest) throw new Error('Invalid seal.');
        seal = { sequence: value.sequence, digest: value.digest };
        transition('child-sealed');
      } catch { review(); throw new Error('Finalization requires review.'); }
    },
    // Escalation, uncertain DB settlement, or IPC/durable-write failure closes
    // admission even if the process subsequently exits with code zero.
    review,
    detach() { child.off('exit', onExit); child.off('error', onError); child.off('disconnect', onDisconnect); },
    async finalize(database: ReturnType<typeof createGuardedTransactions>,
      resolve: (tx: Prisma.TransactionClient, emails: readonly string[]) => Promise<unknown> = resolveIntentUsers): Promise<CleanupPermit> {
      if (permit && ['cleanup-eligible', 'cleaned'].includes(phase)) { assertEvidence(); return permit; }
      if (pending || phase !== 'exit-confirmed') throw new Error('Finalization is not admitted.');
      pending = true;
      const operationGeneration = ++generation;
      const assertFinalizing = () => assertCurrent('finalizing', operationGeneration);
      try {
        transition('finalizing', operationGeneration);
        const start = readJournalSnapshot(journalIo, owner);
        assertFinalizing();
        const intents = start.journal.events.filter((event) => event.kind === 'email').map((event) => event.value);
        const users = z.array(row).parse(intents.length ? await database.$transaction(async (tx) => {
          assertFinalizing(); const found = await resolve(tx, Object.freeze([...intents])); assertFinalizing(); return found;
        }, assertFinalizing) : []);
        assertFinalizing();
        // Reuse the strict bijective ownership validator; no rows may be
        // inferred from a prefix or from an unrecorded email.
        let journal = start.journal;
        for (const user of users) {
          const existing = journal.events.find((event) => event.kind === 'user' && event.email === user.email);
          if (existing && existing.value !== user.id) throw new Error('Contradictory user ownership.');
          if (!existing) journal = parseJournal({ ...journal, events: [...journal.events, { kind: 'user', value: user.id, email: user.email }] }, owner);
        }
        if (new Set(users.map((user) => user.id)).size !== users.length || new Set(users.map((user) => user.email)).size !== users.length) throw new Error('Duplicate resolved ownership.');
        // Append only exact user-resolution records, then one terminal stop.
        let current = start;
        function appendOwnership(next: typeof start.journal) {
          const checked = parseJournal(next, owner);
          assertFinalizing();
          durableAppend(journalIo, { sequence: current.sequence + 1, journal: checked });
          assertPhase('finalizing', operationGeneration);
          const updated = readJournalSnapshot(journalIo, owner);
          assertPhase('finalizing', operationGeneration);
          if (updated.sequence !== current.sequence + 1 || JSON.stringify(updated.journal) !== JSON.stringify(checked)) throw new Error('Ownership append changed.');
          seal = { sequence: updated.sequence, digest: updated.digest };
          current = updated;
          assertFinalizing();
        }
        for (const event of journal.events.slice(start.journal.events.length)) {
          appendOwnership({ ...current.journal, events: [...current.journal.events, event] });
        }
        appendOwnership({ ...current.journal, state: 'stopped' });
        const terminal = current;
        // Persist the terminal digest with cleanup eligibility. A crash in the
        // append-to-ledger window is review-only, never automatically resumed.
        transition('cleanup-eligible', operationGeneration);
        const assertLive = () => assertCurrent('cleanup-eligible', operationGeneration);
        assertLive();
        const issued = Object.freeze({ ownership: 'parent-finalized' as const });
        const ownedUsers = terminal.journal.events.filter((event) => event.kind === 'user').map((event) => ({ id: event.value, email: event.email }));
        assertLive();
        permit = issued;
        permits.set(permit, { owner, io: journalIo, seal: { sequence: terminal.sequence, digest: terminal.digest }, users: ownedUsers,
          hashes: terminal.journal.events.filter((event) => event.kind === 'tokenHash').map((event) => event.value),
          phase: () => phase, transition, assert: assertEvidence, assertLive, review, pending: false });
        return permit;
      } catch { review(); throw new Error('Finalization requires review.'); }
      finally { pending = false; }
    }
  };
}

// Only a permit minted after this parent's observed clean exit can reach a
// deletion adapter. Failed/ambiguous commits permanently consume admission.
export async function withCleanupPermit<T>(permit: CleanupPermit,
  work: (targets: Readonly<{ users: readonly OwnedUser[]; hashes: readonly string[] }>, assertLive: () => void) => Promise<T>): Promise<T | undefined> {
  const authority = permits.get(permit);
  if (!authority || authority.pending) throw new Error('Cleanup is not admitted.');
  try {
    authority.assert();
    if (authority.phase() === 'cleaned') return undefined;
    if (authority.phase() !== 'cleanup-eligible') throw new Error('Cleanup is not admitted.');
    authority.pending = true;
    authority.assertLive();
    const result = await work({ users: structuredClone(authority.users), hashes: [...authority.hashes] }, authority.assertLive);
    authority.assertLive(); authority.transition('cleaned');
    return result;
  } catch { authority.review(); throw new Error('Cleanup requires review.'); }
  finally { authority.pending = false; }
}
