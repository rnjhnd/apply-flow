import { authenticatedResponseSchema, meResponseSchema, type LoginRequest, type RegisterRequest } from '@applyflow/contracts';
import { Prisma, type Session, type User } from '../../generated/prisma/client.ts';
import { AuthHttpError } from './http-error.js';
import type { createPasswordService } from './passwords.js';
import { createSessionService, isSessionValid } from './sessions.js';
import { hashSessionToken, matchesCsrfToken } from './tokens.js';

export type SessionProof = { token: string; csrfToken: string };
export type AuthenticationDatabase = {
  user: Pick<Prisma.TransactionClient['user'], 'findUnique'>;
  $transaction<T>(work: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};
type Passwords = Awaited<ReturnType<typeof createPasswordService>>;
type Options = { now?: () => Date; token?: () => string };

const unauthenticated = () => new AuthHttpError(401, 'UNAUTHENTICATED', 'A valid authenticated session is required.');
const invalidCredentials = () => new AuthHttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export function createAuthenticationService(database: AuthenticationDatabase, passwords: Passwords, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  const sessionOptions = { now: clock, ...(options.token === undefined ? {} : { token: options.token }) };
  async function safely<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof AuthHttpError) throw error;
      // Never expose driver, password backend, constraint, or transaction details.
      throw new AuthHttpError(503, 'SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.', 1);
    }
  }
  async function lockedSession(transaction: Prisma.TransactionClient, proof: SessionProof, kind: 'anonymous' | 'authenticated', csrf = true) {
    // Recheck after acquiring the row lock: a preflight read/password verification is not authority to consume it.
    const rows = await transaction.$queryRaw<Session[]>`
      SELECT * FROM public."Session" WHERE "tokenHash" = ${hashSessionToken(proof.token)} FOR UPDATE
    `;
    const session = rows[0];
    if (!session) throw new AuthHttpError(409, 'SESSION_CHANGED', 'The session changed. Retrieve a new CSRF token and retry.');
    if (!isSessionValid(session, clock())) throw unauthenticated();
    if (kind === 'authenticated' && session.userId === null) throw unauthenticated();
    if (csrf && !matchesCsrfToken(session.csrfToken, proof.csrfToken)) {
      throw new AuthHttpError(403, 'REQUEST_REJECTED', 'Authentication request rejected.');
    }
    if (kind === 'anonymous' && session.userId !== null) {
      throw new AuthHttpError(409, 'ALREADY_AUTHENTICATED', 'Log out before authenticating another session.');
    }
    return session;
  }
  async function replace(transaction: Prisma.TransactionClient, previous: Session, user: { id: string; email: string }) {
    await transaction.session.delete({ where: { id: previous.id } });
    const created = await createSessionService(transaction, sessionOptions).createAuthenticated(user.id);
    // Validate the public response before commit. No database record is ever serialized as a user DTO.
    const body = authenticatedResponseSchema.parse({ user: { id: user.id, email: user.email }, csrfToken: created.session.csrfToken });
    return { body, token: created.token, expiresAt: created.session.expiresAt };
  }
  return {
    register(input: RegisterRequest, proof: SessionProof) {
      return safely(async () => {
        // Do costly work before taking locks, with the existing two-operation Argon2 gate.
        const passwordHash = await passwords.hash(input.password);
        return database.$transaction(async (transaction) => {
          const previous = await lockedSession(transaction, proof, 'anonymous');
          let user;
          try {
            user = await transaction.user.create({ data: { email: input.email, passwordHash }, select: { id: true, email: true } });
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              throw new AuthHttpError(409, 'ACCOUNT_UNAVAILABLE', 'Unable to create an account with those details.');
            }
            throw error;
          }
          return replace(transaction, previous, user);
        });
      });
    },
    login(input: LoginRequest, proof: SessionProof) {
      return safely(async () => {
        const user = await database.user.findUnique({ where: { email: input.email }, select: { id: true, email: true, passwordHash: true } });
        const valid = await passwords.verify(user?.passwordHash ?? null, input.password);
        if (!user || !valid) throw invalidCredentials();
        return database.$transaction(async (transaction) => {
          const previous = await lockedSession(transaction, proof, 'anonymous');
          // Hold the verified credential stable until commit, including against non-key password updates.
          const users = await transaction.$queryRaw<Array<Pick<User, 'id' | 'email' | 'passwordHash'>>>`
            SELECT id, email, "passwordHash" FROM public."User" WHERE id = ${user.id}::uuid FOR SHARE
          `;
          const current = users[0];
          if (!current || current.passwordHash !== user.passwordHash) throw invalidCredentials();
          return replace(transaction, previous, current);
        });
      });
    },
    me(token: string) {
      return safely(() => database.$transaction(async (transaction) => {
        const previous = await lockedSession(transaction, { token, csrfToken: '' }, 'authenticated', false);
        const refreshed = await createSessionService(transaction, sessionOptions).refreshAuthenticated(token);
        if (!refreshed || !previous.userId) throw unauthenticated();
        const user = await transaction.user.findUnique({ where: { id: previous.userId }, select: { id: true, email: true } });
        if (!user) throw unauthenticated();
        return meResponseSchema.parse({ user });
      }));
    },
    logout(proof: SessionProof) {
      return safely(() => database.$transaction(async (transaction) => {
        const previous = await lockedSession(transaction, proof, 'authenticated');
        await transaction.session.delete({ where: { id: previous.id } });
      }));
    }
  };
}

export type AuthenticationService = ReturnType<typeof createAuthenticationService>;
