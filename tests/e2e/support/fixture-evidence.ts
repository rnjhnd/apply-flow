import { z } from 'zod';
import { canonicalOwner, type Owner } from './ownership.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';
import { durableAppend } from './safety-io.js';
import { digest } from './schema.js';

const observation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), id: z.uuid().transform((id) => id.toLowerCase()), email: z.email() }),
  z.strictObject({ kind: z.literal('session'), id: z.uuid().transform((id) => id.toLowerCase()),
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/), userId: z.uuid().transform((id) => id.toLowerCase()).nullable() })
]);
export type FixtureObservation = z.infer<typeof observation>;
type Stage = 'started' | 'observed-before-commit' | 'confirmed-commit' | 'uncertain-outcome';
const entrySchema = z.strictObject({ version: z.literal(1), runId: z.uuid(), testId: z.uuid(),
  sequence: z.number().int().nonnegative(), previousDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  operationId: z.uuid(), operation: z.enum(['anonymous', 'registration']),
  stage: z.enum(['started', 'observed-before-commit', 'confirmed-commit', 'uncertain-outcome']),
  journalSequence: z.number().int().nonnegative(), journalDigest: z.string().regex(/^[a-f0-9]{64}$/), observation: observation.optional() });

export function readOperationLedger(owner: Owner, io: JournalIo, journal: JournalIo) {
  owner = canonicalOwner(owner);
  try {
    const contents = io.read(); const history = journal.read();
    readJournalSnapshot(journal, owner);
    if (!contents.endsWith('\n') || contents.length > 1024 * 1024) throw new Error();
    const lines = contents.slice(0, -1).split('\n');
    if (lines.length > 100) throw new Error();
    const states = new Map<string, { stage: Stage; operation: string }>(); let previous: string | null = null;
    for (const [index, line] of lines.entries()) {
      const row = entrySchema.parse(JSON.parse(line)); const old = states.get(row.operationId);
      const prefix = history.split('\n').slice(0, row.journalSequence + 1).join('\n') + '\n';
      const snapshot = readJournalSnapshot({ read: () => prefix, append() { throw new Error(); } }, owner);
      if (row.runId !== owner.runId || row.testId !== owner.testId || row.sequence !== index || row.previousDigest !== previous
        || row.journalDigest !== snapshot.digest || row.journalSequence !== snapshot.sequence
        || (old && old.operation !== row.operation)
        || (row.stage === 'started' ? old !== undefined : row.stage === 'observed-before-commit' ? old?.stage !== 'started'
          : row.stage === 'confirmed-commit' ? old?.stage !== 'observed-before-commit'
            : old?.stage !== 'started' && old?.stage !== 'observed-before-commit')
        || (row.stage === 'observed-before-commit') !== (row.observation !== undefined)) throw new Error();
      const seen = row.observation;
      if (seen && (row.operation === 'anonymous' ? seen.kind !== 'session' || seen.userId !== null : seen.kind !== 'user')) throw new Error();
      if (seen?.kind === 'user' && !snapshot.journal.events.some((event) => event.kind === 'user' && event.value === seen.id && event.email === seen.email)) throw new Error();
      if (seen?.kind === 'session' && !snapshot.journal.events.some((event) => event.kind === 'tokenHash' && event.value === seen.tokenHash)) throw new Error();
      states.set(row.operationId, { stage: row.stage, operation: row.operation }); previous = digest(line + '\n');
    }
    return { sequence: lines.length - 1, digest: digest(contents), settled: states.size === 2
      && [...states.values()].every((value) => value.stage === 'confirmed-commit')
      && new Set([...states.values()].map((value) => value.operation)).size === 2 };
  } catch { throw new Error('Fixture operation evidence requires review.'); }
}

// Separate from the version-1 ownership journal. No generic context/error/result
// argument is serializable here. Partial writes permanently close this instance.
export function createOperationLedger(owner: Owner, io: JournalIo, journal: JournalIo, review: () => void) {
  owner = canonicalOwner(owner);
  let contents = ''; let sequence = 0; let previousDigest: string | null = null; let failed = false;
  const operations = new Map<string, Stage>();
  function append(operationId: string, operation: 'anonymous' | 'registration', stage: Stage, value?: FixtureObservation) {
    try {
      if (failed || sequence >= 100 || (sequence > 0 && io.read() !== contents)) throw new Error();
      z.uuid().parse(operationId);
      const old = operations.get(operationId);
      z.enum(['anonymous', 'registration']).parse(operation);
      if ((stage === 'started' && old !== undefined) || (stage === 'observed-before-commit' && old !== 'started')
        || (stage === 'confirmed-commit' && old !== 'observed-before-commit')
        || (stage === 'uncertain-outcome' && old !== 'started' && old !== 'observed-before-commit')) throw new Error();
      const snapshot = readJournalSnapshot(journal, owner);
      if (snapshot.journal.state !== 'running') throw new Error();
      const checked = value === undefined ? undefined : observation.parse(value);
      if (stage === 'observed-before-commit' && !checked) throw new Error();
      if (checked && (operation === 'anonymous' ? checked.kind !== 'session' || checked.userId !== null : checked.kind !== 'user')) throw new Error();
      if (checked?.kind === 'user' && !snapshot.journal.events.some((event) => event.kind === 'user'
        && event.value === checked.id && event.email === checked.email)) throw new Error();
      if (checked?.kind === 'session' && !snapshot.journal.events.some((event) => event.kind === 'tokenHash' && event.value === checked.tokenHash)) throw new Error();
      const entry = { version: 1, runId: owner.runId, testId: owner.testId, sequence, previousDigest,
        operationId, operation, stage, journalSequence: snapshot.sequence, journalDigest: snapshot.digest,
        ...(checked ? { observation: checked } : {}) };
      const line = `${JSON.stringify(entry)}\n`;
      durableAppend(io, entry, sequence === 0);
      if (io.read() !== contents + line) throw new Error();
      contents += line; previousDigest = digest(line); sequence++; operations.set(operationId, stage);
    } catch { failed = true; try { review(); } catch { /* No raw reporting failure. */ } throw new Error('Fixture operation evidence requires review.'); }
  }
  return Object.freeze({
    start: (id: string, operation: 'anonymous' | 'registration') => append(id, operation, 'started'),
    observe: (id: string, operation: 'anonymous' | 'registration', value: FixtureObservation) => append(id, operation, 'observed-before-commit', value),
    committed: (id: string, operation: 'anonymous' | 'registration') => append(id, operation, 'confirmed-commit'),
    uncertain(id: string, operation: 'anonymous' | 'registration') {
      try { append(id, operation, 'uncertain-outcome'); } finally { failed = true; try { review(); } catch { /* Terminal. */ } }
    },
    assertSettled() {
      let settled = false;
      try { settled = !failed && !!contents && io.read() === contents && readOperationLedger(owner, io, journal).settled; } catch { /* Fixed failure below. */ }
      if (!settled) { failed = true; try { review(); } catch { /* No raw reporter exception. */ } throw new Error('Fixture operation settlement requires review.'); }
    },
    snapshot: () => readOperationLedger(owner, io, journal)
  });
}
export type OperationLedger = ReturnType<typeof createOperationLedger>;
