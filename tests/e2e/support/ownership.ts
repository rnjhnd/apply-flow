import { z } from 'zod';
import { generateToken, hashSessionToken } from '../../../apps/api/src/modules/auth/tokens.js';

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('email'), value: z.email().max(254) }),
  // User UUIDs compare and plan canonically. Run/test IDs and emails retain
  // their exact spelling checks; no namespace matching is broadened.
  z.strictObject({ kind: z.literal('user'), value: id.transform((value) => value.toLowerCase()), email: z.email().max(254) }),
  z.strictObject({ kind: z.literal('tokenHash'), value: hash })
]);
export type OwnershipEvent = z.infer<typeof eventSchema>;
const journalSchema = z.strictObject({ version: z.literal(1), runId: id, testId: id,
  state: z.enum(['running', 'stopped']), events: z.array(eventSchema).max(10_000) });
export type OwnershipJournal = z.infer<typeof journalSchema>;
export type Owner = Pick<OwnershipJournal, 'runId' | 'testId'>;
const ownerSchema = z.object({ runId: id, testId: id });

// Owner/context inputs may contain unrelated application state. Drop every
// non-allowlisted field without reading/serializing it; reject malformed IDs.
export function canonicalOwner(input: Owner): Readonly<Owner> {
  const result = ownerSchema.safeParse(input);
  if (!result.success) throw new Error('Invalid fixture owner.');
  return Object.freeze({ runId: result.data.runId, testId: result.data.testId });
}

export function ownedEmail(owner: Owner, suffix: string): string {
  owner = canonicalOwner(owner);
  if (!/^[a-f0-9-]{1,36}$/.test(suffix)) throw new Error('Invalid fixture suffix.');
  return `e2e-${owner.runId}-${owner.testId}-${suffix}@example.invalid`;
}

export function parseJournal(input: unknown, owner: Owner): OwnershipJournal {
  owner = canonicalOwner(owner);
  const result = journalSchema.safeParse(input);
  if (!result.success) throw new Error('Missing or malformed ownership journal.');
  const journal = result.data;
  if (journal.runId !== owner.runId || journal.testId !== owner.testId) throw new Error('Unauthorized fixture owner.');
  const prefix = `e2e-${journal.runId}-${journal.testId}-`;
  const emails = new Set<string>();
  const users = new Set<string>();
  const userEmails = new Set<string>();
  const tokenHashes = new Set<string>();
  for (const event of journal.events) {
    const email = event.kind === 'email' ? event.value : event.kind === 'user' ? event.email : undefined;
    if (email !== undefined && (!email.startsWith(prefix)
      || !/^[a-f0-9-]{1,36}@example\.invalid$/.test(email.slice(prefix.length)))) {
      throw new Error('Fixture email is outside exact ownership.');
    }
    if (event.kind === 'email') {
      if (emails.has(event.value)) throw new Error('Duplicate email intent.');
      emails.add(event.value);
    }
    if (event.kind === 'user') {
      if (!emails.has(event.email) || users.has(event.value) || userEmails.has(event.email)) {
        throw new Error('Ambiguous user ownership.');
      }
      users.add(event.value);
      userEmails.add(event.email);
    }
    if (event.kind === 'tokenHash') {
      if (tokenHashes.has(event.value)) throw new Error('Duplicate token ownership.');
      tokenHashes.add(event.value);
    }
  }
  return journal;
}

// A pure plan, never a database delete. No prefix-only/age/expiry predicates.
// Future adapter must resolve exact email intents, verify each row against this
// journal, then journal its UUID before deleting by BOTH UUID and exact email.
export function planCleanup(input: unknown, owner: Owner) {
  const journal = parseJournal(input, owner);
  if (journal.state !== 'stopped') throw new Error('Cleanup requires confirmed child exit.');
  return {
    users: journal.events.filter((e) => e.kind === 'user').map((e) => ({ id: e.value, email: e.email })),
    resolveEmails: [...new Set(journal.events.filter((e) => e.kind === 'email').map((e) => e.value))],
    sessionTokenHashes: [...new Set(journal.events.filter((e) => e.kind === 'tokenHash').map((e) => e.value))]
  };
}

export type DurableRecord = (event: OwnershipEvent) => void;
// The sink MUST synchronously fsync before returning. Never use an async sink.
// Existing services request both session and CSRF candidates through this hook;
// harmless unmatched candidate hashes are retained, never their raw values.
export function recordingTokenFactory(record: DurableRecord): () => string {
  return () => {
    const token = generateToken();
    const result: unknown = record({ kind: 'tokenHash', value: hashSessionToken(token) });
    if (result !== undefined) throw new Error('Ownership recording must finish synchronously.');
    return token;
  };
}

export function beforeFixtureWrite<T>(record: DurableRecord, event: OwnershipEvent, write: () => T): T {
  const result: unknown = record(event);
  if (result !== undefined) throw new Error('Ownership recording must finish synchronously.');
  return write();
}
