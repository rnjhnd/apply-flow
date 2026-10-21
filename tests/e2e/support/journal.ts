import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalOwner, parseJournal, type Owner, type OwnershipEvent, type OwnershipJournal } from './ownership.js';
import { digest } from './schema.js';

export type JournalIo = { read(): string; append(line: string, exclusive: boolean): void };

// Fixed repository-local path. No caller-supplied directory or secret filename.
export function fileJournalIo(owner: Owner): JournalIo {
  owner = canonicalOwner(owner);
  const directory = fileURLToPath(new URL(`../../../.cache/e2e/${owner.runId}/`, import.meta.url));
  const file = join(directory, `${owner.testId}.jsonl`);
  return {
    read: () => readFileSync(file, 'utf8'),
    append: (line, exclusive) => {
      mkdirSync(directory, { recursive: true });
      const fd = openSync(file, exclusive ? 'wx' : 'a', 0o600);
      try {
        const bytes = Buffer.from(line, 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Incomplete ownership journal write.');
          offset += written;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  };
}

const lineSchema = z.strictObject({ sequence: z.number().int().nonnegative(), journal: z.unknown() });

// Append-only snapshots allow truncated/partial writes to fail closed. Do not
// silently salvage or automatically clean an interrupted run.
export function readJournal(io: JournalIo, owner: Owner): OwnershipJournal {
  return readJournalSnapshot(io, owner).journal;
}

export function readJournalSnapshot(io: JournalIo, owner: Owner) {
  owner = canonicalOwner(owner);
  try {
    const contents = io.read();
    if (!contents.endsWith('\n') || contents.length > 32 * 1024 * 1024) throw new Error('Incomplete journal.');
    const lines = contents.slice(0, -1).split('\n');
    let previous: OwnershipJournal | undefined;
    for (const [index, line] of lines.entries()) {
      const entry = lineSchema.parse(JSON.parse(line));
      const current = parseJournal(entry.journal, owner);
      if (entry.sequence !== index || (index === 0 && (current.state !== 'running' || current.events.length !== 0))) {
        throw new Error('Unexpected journal sequence.');
      }
      if (previous && (previous.state === 'stopped'
        || JSON.stringify(current.events.slice(0, previous.events.length)) !== JSON.stringify(previous.events)
        || (current.state === 'running' && current.events.length !== previous.events.length + 1)
        || (current.state === 'stopped' && current.events.length !== previous.events.length))) {
        throw new Error('Non-append ownership history.');
      }
      previous = current;
    }
    if (!previous) throw new Error('Missing journal.');
    return { journal: previous, sequence: lines.length - 1, digest: digest(contents) };
  } catch { throw new Error('Missing, malformed, or ambiguous ownership journal; manual review required.'); }
}

export function createJournal(io: JournalIo, owner: Owner) {
  owner = canonicalOwner(owner);
  let journal = parseJournal({ version: 1, runId: owner.runId, testId: owner.testId, state: 'running', events: [] }, owner);
  let sequence = 0;
  let sealed = false;
  io.append(`${JSON.stringify({ sequence, journal })}\n`, true);
  function append(next: OwnershipJournal) {
    // Detect competing writers or reuse rather than overwriting their state.
    if (JSON.stringify(readJournal(io, owner)) !== JSON.stringify(journal)) throw new Error('Concurrent journal writer.');
    const checked = parseJournal(next, owner);
    io.append(`${JSON.stringify({ sequence: sequence + 1, journal: checked })}\n`, false);
    journal = checked;
    sequence++;
  }
  return {
    record(event: OwnershipEvent): void {
      if (sealed || journal.state !== 'running') throw new Error('Fixture ownership is closed.');
      append({ ...journal, events: [...journal.events, event] });
    },
    // Future lifecycle adapter may call ONLY after observing child exit. Merely
    // sending shutdown/kill or losing IPC is insufficient evidence.
    markExited(): void {
      if (sealed || journal.state !== 'running') throw new Error('Fixture ownership is already closed.');
      append({ ...journal, state: 'stopped' });
    },
    // Sealing closes this writer without pretending the child can observe its
    // own exit. Only the parent finalizer may append resolved user ownership.
    sealForHandoff() {
      if (sealed || journal.state !== 'running') throw new Error('Fixture ownership is closed.');
      sealed = true;
      return readJournalSnapshot(io, owner);
    }
  };
}

export function interruptedRun(io: JournalIo, owner: Owner): 'review-required' | 'stopped' {
  return readJournal(io, owner).state === 'running' ? 'review-required' : 'stopped';
}
