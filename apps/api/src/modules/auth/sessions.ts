import { Prisma, type Session } from '../../generated/prisma/client.ts';
import { generateToken, hashSessionToken, isToken } from './tokens.js';

export const ANONYMOUS_LIFETIME_MS = 15 * 60_000;
export const IDLE_LIFETIME_MS = 24 * 60 * 60_000;
export const ABSOLUTE_LIFETIME_MS = 7 * IDLE_LIFETIME_MS;
export type SessionDatabase = Pick<Prisma.TransactionClient, 'session' | '$queryRaw'>;
type Options = { now?: () => Date; token?: () => string };

export function isSessionValid(session: Session, now: Date): boolean {
  const time = now.getTime();
  return Number.isFinite(time) && session.createdAt.getTime() <= time && time < session.expiresAt.getTime()
    && (session.userId === null ? time < session.createdAt.getTime() + ANONYMOUS_LIFETIME_MS
      : time < session.createdAt.getTime() + ABSOLUTE_LIFETIME_MS && time < session.lastSeenAt.getTime() + IDLE_LIFETIME_MS);
}

export function createSessionService(database: SessionDatabase, options: Options = {}) {
  const clock = options.now ?? (() => new Date());
  const tokenFactory = options.token ?? generateToken;
  function now() {
    const value = new Date(clock().getTime());
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid session clock.');
    return value;
  }
  async function create(userId: string | null) {
    const createdAt = now();
    const token = tokenFactory();
    const csrfToken = tokenFactory();
    if (!isToken(token) || !isToken(csrfToken) || token === csrfToken) throw new Error('Invalid session entropy source.');
    const session = await database.session.create({ data: { userId, tokenHash: hashSessionToken(token), csrfToken,
      createdAt, lastSeenAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + (userId === null ? ANONYMOUS_LIFETIME_MS : ABSOLUTE_LIFETIME_MS)) } });
    // Resolves after its statement commits, or while inside the caller's explicit transaction.
    return { token, session };
  }
  return {
    createAnonymous: () => create(null),
    createAuthenticated(userId: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new Error('Invalid session owner.');
      return create(userId);
    },
    async findValid(token: string): Promise<Session | null> {
      if (!isToken(token)) return null;
      const session = await database.session.findUnique({ where: { tokenHash: hashSessionToken(token) } });
      return session && isSessionValid(session, now()) ? session : null;
    },
    async refreshAuthenticated(token: string): Promise<Session | null> {
      if (!isToken(token)) return null;
      const time = now();
      const sessions = await database.$queryRaw<Session[]>`
        UPDATE public."Session" SET "lastSeenAt" = GREATEST("lastSeenAt", ${time})
        WHERE "tokenHash" = ${hashSessionToken(token)} AND "userId" IS NOT NULL
          AND "createdAt" <= ${time} AND "createdAt" > ${new Date(time.getTime() - ABSOLUTE_LIFETIME_MS)}
          AND "lastSeenAt" > ${new Date(time.getTime() - IDLE_LIFETIME_MS)} AND "expiresAt" > ${time}
        RETURNING *
      `;
      return sessions[0] ?? null;
    },
    async revoke(token: string): Promise<boolean> {
      if (!isToken(token)) return false;
      return (await database.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } })).count === 1;
    },
    async cleanupExpired(limit = 100): Promise<number> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Cleanup batch must contain 1–100 sessions.');
      const time = now();
      const expired = Prisma.sql`(s."expiresAt" <= ${time}
        OR (s."userId" IS NULL AND s."createdAt" <= ${new Date(time.getTime() - ANONYMOUS_LIFETIME_MS)})
        OR (s."userId" IS NOT NULL AND (s."createdAt" <= ${new Date(time.getTime() - ABSOLUTE_LIFETIME_MS)}
          OR s."lastSeenAt" <= ${new Date(time.getTime() - IDLE_LIFETIME_MS)})))`;
      const deleted = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH candidates AS (
          SELECT s.id FROM public."Session" s WHERE ${expired}
          ORDER BY s."expiresAt", s.id LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        DELETE FROM public."Session" s USING candidates c WHERE s.id = c.id AND ${expired} RETURNING s.id
      `);
      return deleted.length;
    }
  };
}
