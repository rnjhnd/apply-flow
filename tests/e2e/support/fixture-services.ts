import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerRequestSchema } from '@applyflow/contracts';
import { createSessionService } from '../../../apps/api/src/modules/auth/sessions.js';
import { createAuthenticationService } from '../../../apps/api/src/modules/auth/authentication.js';
import { createPasswordService } from '../../../apps/api/src/modules/auth/passwords.js';
import { parseAuthConfig, isRegistrationEnabled } from '../../../apps/api/src/config/auth.js';
import { hashSessionToken } from '../../../apps/api/src/modules/auth/tokens.js';
import type { createGuardedTransactions } from './guarded-database.js';
import type { createChildRecorder } from './child-protocol.js';
import type { OperationLedger } from './fixture-evidence.js';
import { recordingTokenFactory, type Owner } from './ownership.js';
import { readJournalSnapshot, type JournalIo } from './journal.js';

const user = z.strictObject({ id: z.uuid().transform((id) => id.toLowerCase()), email: z.email() });
type Guarded = ReturnType<typeof createGuardedTransactions>;

// Stronger resolver supplied through the existing finalizer injection point:
// an email intent cannot adopt a pre-existing/manual account, even after a lost response.
export function recordedUsers(owner: Owner, journal: JournalIo, emails: readonly string[], rows: unknown) {
  const snapshot = readJournalSnapshot(journal, owner);
  const found = z.array(user).parse(rows);
  if (new Set(found.map((row) => row.id)).size !== found.length || new Set(found.map((row) => row.email)).size !== found.length
    || found.some((row) => !emails.includes(row.email) || !snapshot.journal.events.some((event) => event.kind === 'user'
      && event.value === row.id && event.email === row.email))) throw new Error('Unproven fixture user ownership.');
  return found;
}

// Only the approved anonymous -> register -> read-back cycle is exposed. No
// HTTP, login/logout, expiry cleanup or user-seeding API is provided.
export async function runServiceFixture(email: string, database: Guarded,
  recorder: ReturnType<typeof createChildRecorder>, ledger: OperationLedger,
  dependencies: { passwords: typeof createPasswordService; now: () => Date; id: () => string; password: () => string } = {
    passwords: createPasswordService, now: () => new Date(), id: randomUUID, password: () => randomBytes(32).toString('hex')
  }) {
  recorder.assertIntent(email);
  if (!isRegistrationEnabled(parseAuthConfig({ NODE_ENV: 'test', ALLOW_LOCAL_REGISTRATION: 'true' }))) throw new Error('Fixture registration unavailable.');
  const token = recordingTokenFactory(recorder.record);
  return recorder.request(async () => {
    const passwords = await dependencies.passwords();
    const anonymousId = dependencies.id(); const registrationId = dependencies.id();
    let currentId = anonymousId; let currentOperation: 'anonymous' | 'registration' = 'anonymous';
    try {
      ledger.start(anonymousId, 'anonymous');
      const anonymous = await database.$transaction(async (tx) => {
        if (await tx.user.findUnique({ where: { email }, select: { id: true } })) throw new Error('Fixture intent already exists.');
        const created = await createSessionService(tx, { token, now: dependencies.now }).createAnonymous();
        ledger.observe(anonymousId, 'anonymous', { kind: 'session', id: created.session.id,
          tokenHash: created.session.tokenHash, userId: null });
        return created;
      });
      ledger.committed(anonymousId, 'anonymous');
      currentId = registrationId; currentOperation = 'registration';
      ledger.start(registrationId, 'registration');
      const authDatabase = {
        // Registration never uses an outside-transaction credential read.
        user: { findUnique: (() => { throw new Error('Unexpected fixture credential lookup.'); }) as Parameters<typeof createAuthenticationService>[0]['user']['findUnique'] },
        $transaction: (<T>(work: Parameters<Guarded['$transaction']>[0]) => database.$transaction(async (tx) => {
          if (await tx.user.findUnique({ where: { email }, select: { id: true } })) throw new Error('Fixture intent already exists.');
          const result = await work(tx);
          const created = user.parse(await tx.user.findUnique({ where: { email }, select: { id: true, email: true } }));
          if (created.email !== email) throw new Error('Unexpected fixture owner.');
          recorder.record({ kind: 'user', value: created.id, email: created.email });
          ledger.observe(registrationId, 'registration', { kind: 'user', id: created.id, email: created.email });
          return result as T;
        })) as Parameters<typeof createAuthenticationService>[0]['$transaction']
      };
      const authentication = createAuthenticationService(authDatabase, passwords, { token, now: dependencies.now });
      const input = registerRequestSchema.parse({ email, password: dependencies.password() });
      const registered = await authentication.register(input, { token: anonymous.token, csrfToken: anonymous.session.csrfToken });
      ledger.committed(registrationId, 'registration');
      await database.$transaction(async (tx) => {
        const old = await tx.session.findUnique({ where: { tokenHash: hashSessionToken(anonymous.token) } });
        const current = await tx.session.findUnique({ where: { tokenHash: hashSessionToken(registered.token) } });
        const sessions = await tx.session.count({ where: { userId: registered.body.user.id } });
        if (old || !current || current.userId !== registered.body.user.id || sessions !== 1
          || !await createSessionService(tx, { now: dependencies.now }).findValid(registered.token)) throw new Error('Fixture rotation verification failed.');
      });
      ledger.assertSettled();
      // Secrets and auth responses never cross the child IPC boundary.
      return Object.freeze({ usersCreated: 1 as const, sessionsCreated: 2 as const, rotations: 1 as const });
    } catch {
      try { ledger.uncertain(currentId, currentOperation); } catch { /* Preserve failed evidence; recorder also closes admission. */ }
      throw new Error('Fixture cycle requires review.');
    }
  });
}
