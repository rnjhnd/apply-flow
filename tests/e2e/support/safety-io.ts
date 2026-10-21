import { digest } from './schema.js';
import type { JournalIo } from './journal.js';
import { canonicalOwner, type Owner } from './ownership.js';

export function durableAppend(io: JournalIo, value: unknown, exclusive = false): void {
  const returned: unknown = io.append(`${JSON.stringify(value)}\n`, exclusive);
  if (returned !== undefined) throw new Error('Evidence persistence must be synchronous.');
}
export type LeaseIo = { claim(key: string, contents: string): void; read(key: string): string; release(key: string, contents: string): void };
export function acquireLease(io: LeaseIo, owner: Owner, kind: 'run' | 'finalizer') {
  owner = canonicalOwner(owner);
  const key = kind === 'run' ? 'active-run' : `finalizer-${owner.runId}-${owner.testId}`;
  const contents = JSON.stringify({ version: 1, kind, runId: owner.runId, testId: owner.testId });
  const result: unknown = io.claim(key, contents);
  if (result !== undefined) throw new Error('Lease creation must be synchronous.');
  let released = false;
  return {
    assertFor(expected: Owner, expectedKind: 'run' | 'finalizer') {
      expected = canonicalOwner(expected);
      if (expectedKind !== kind || expected.runId !== owner.runId || expected.testId !== owner.testId
        || released || io.read(key) !== contents) throw new Error('Incorrect ownership lease.');
    },
    assertHeld() { if (released || io.read(key) !== contents) throw new Error('Ownership lease changed.'); },
    release() {
      if (released || io.read(key) !== contents) throw new Error('Ownership lease changed.');
      const result: unknown = io.release(key, contents);
      if (result !== undefined) throw new Error('Lease release must be synchronous.');
      released = true;
    },
    fingerprint: digest(contents)
  };
}
