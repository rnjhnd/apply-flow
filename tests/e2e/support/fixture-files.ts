import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { canonicalOwner, type Owner } from './ownership.js';
import type { JournalIo } from './journal.js';

// No I/O on construction. Child is the sole operation-ledger writer. No caller
// path, generic context or credential is used in a file name.
export function fileOperationLedger(owner: Owner): JournalIo {
  owner = canonicalOwner(owner);
  const directory = fileURLToPath(new URL(`../../../.cache/e2e/${owner.runId}/`, import.meta.url));
  const path = join(directory, `${owner.testId}.operations.jsonl`);
  return {
    read: () => readFileSync(path, 'utf8'),
    append(line, exclusive) {
      mkdirSync(directory, { recursive: true });
      const fd = openSync(path, exclusive ? 'wx' : 'a', 0o600);
      try {
        const bytes = Buffer.from(line); let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new Error('Incomplete fixture evidence write.'); offset += count;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  };
}
