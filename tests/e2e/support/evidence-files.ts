import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LeaseIo } from './safety-io.js';
import { canonicalOwner, type Owner } from './ownership.js';
import type { JournalIo } from './journal.js';

function append(path: string, contents: string, exclusive: boolean) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, exclusive ? 'wx' : 'a', 0o600);
  try {
    const bytes = Buffer.from(contents); let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Incomplete evidence write.'); offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

// Construction and imports do no I/O. Paths are repository-local and fixed.
// These adapters are exercised only with mocked fs in B1.
export function fileEvidence(owner: Owner): { ledger: JournalIo; leases: LeaseIo } {
  owner = canonicalOwner(owner);
  const root = fileURLToPath(new URL('../../../.cache/e2e/', import.meta.url));
  const ledger = join(root, owner.runId, `${owner.testId}.finalization.jsonl`);
  const finalizerKey = `finalizer-${owner.runId}-${owner.testId}`;
  function leasePath(key: string) {
    if (key !== 'active-run' && key !== finalizerKey) throw new Error('Unauthorized evidence path.');
    return key === 'active-run' ? join(root, 'active-run.lease') : join(root, owner.runId, `${owner.testId}.finalizer.lease`);
  }
  function checked(key: string, contents: string) {
    const expected = JSON.stringify({ version: 1, kind: key === 'active-run' ? 'run' : 'finalizer', runId: owner.runId, testId: owner.testId });
    if (contents !== expected) throw new Error('Unexpected lease metadata.');
    return leasePath(key);
  }
  return {
    ledger: { read: () => readFileSync(ledger, 'utf8'), append: (line, exclusive) => append(ledger, line, exclusive) },
    leases: {
      claim(key, contents) { append(checked(key, contents), contents, true); },
      read(key) { return readFileSync(leasePath(key), 'utf8'); },
      release(key, contents) {
        const path = checked(key, contents);
        if (readFileSync(path, 'utf8') !== contents) throw new Error('Ownership lease changed.');
        // Only the holder may release; stale leases are never removed or stolen
        // on startup. A failed write deliberately leaves review evidence.
        unlinkSync(path);
      }
    }
  };
}
