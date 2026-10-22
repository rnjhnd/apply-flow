import { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';
import { z } from 'zod';
import { withCleanupPermit, type CleanupPermit, type OwnedUser } from './finalization.js';
import type { createGuardedTransactions } from './guarded-database.js';

const session = z.strictObject({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/), userId: z.uuid().transform((id) => id.toLowerCase()).nullable() });
const user = z.strictObject({ id: z.uuid().transform((id) => id.toLowerCase()), email: z.email() });
export type CleanupSession = z.infer<typeof session>;
type Targets = { users: readonly OwnedUser[]; hashes: readonly string[] };
export type CleanupRepository = {
  // Must lock sorted user UUIDs first (FOR UPDATE), then all matching hashes
  // AND all sessions related to those users (FOR UPDATE), on this exact tx.
  lock(tx: Prisma.TransactionClient, targets: Targets): Promise<{ users: unknown; sessions: unknown }>;
  deleteSessions(tx: Prisma.TransactionClient, rows: readonly CleanupSession[]): Promise<unknown>;
  deleteUsers(tx: Prisma.TransactionClient, rows: readonly OwnedUser[]): Promise<unknown>;
  // A separate guarded, read-only post-commit inspection. Any remaining exact
  // target or failed/ambiguous verification preserves evidence for review.
  verifyAbsent(targets: Targets): Promise<boolean>;
};
const canonical = (rows: readonly unknown[]) => rows.map((value) => JSON.stringify(value)).sort().join('\n');

export function executeCleanup(permit: CleanupPermit, database: ReturnType<typeof createGuardedTransactions>, repository: CleanupRepository) {
  return withCleanupPermit(permit, async (targets, assertLive) => {
    assertLive();
    if (targets.users.length === 0 && targets.hashes.length === 0) return;
    await database.$transaction(async (tx) => {
      const locked = await repository.lock(tx, targets);
      assertLive();
      const users = z.array(user).parse(locked.users);
      const sessions = z.array(session).parse(locked.sessions);
      const owned = new Map(targets.users.map((item) => [item.id, item.email]));
      const hashes = new Set(targets.hashes);
      if (new Set(users.map((item) => item.id)).size !== users.length
        || users.some((item) => owned.get(item.id) !== item.email)
        || new Set(sessions.map((item) => item.tokenHash)).size !== sessions.length
        || sessions.some((item) => !hashes.has(item.tokenHash) || (item.userId !== null && !owned.has(item.userId)))) {
        throw new Error('Unexpected cleanup relationships.');
      }
      if (sessions.length) {
        assertLive();
        const deleted = z.array(session).parse(await repository.deleteSessions(tx, sessions));
        assertLive();
        if (canonical(deleted) !== canonical(sessions)) throw new Error('Unexpected affected sessions.');
      }
      if (users.length) {
        assertLive();
        const deleted = z.array(user).parse(await repository.deleteUsers(tx, users));
        assertLive();
        if (canonical(deleted) !== canonical(users)) throw new Error('Unexpected affected users.');
      }
      assertLive();
    }, assertLive);
    assertLive();
    if (!await repository.verifyAbsent(targets)) throw new Error('Cleanup verification failed.');
    assertLive();
  });
}

// Prepared SQL only: no driver construction or execution. Empty sets yield no
// query. Explicit child deletion plus NOT EXISTS prevents accidental cascade.
export const cleanupSql = {
  lockUsers(users: readonly OwnedUser[]) {
    return users.length ? Prisma.sql`SELECT id, email FROM public."User" WHERE id IN (${Prisma.join(users.map((row) => Prisma.sql`${row.id}::uuid`))}) ORDER BY id FOR UPDATE` : undefined;
  },
  lockSessions(targets: Targets) {
    const hashes = targets.hashes.length ? Prisma.sql`"tokenHash" IN (${Prisma.join(targets.hashes)})` : Prisma.sql`FALSE`;
    const users = targets.users.length ? Prisma.sql`"userId" IN (${Prisma.join(targets.users.map((row) => Prisma.sql`${row.id}::uuid`))})` : Prisma.sql`FALSE`;
    return targets.hashes.length || targets.users.length
      ? Prisma.sql`SELECT "tokenHash", "userId" FROM public."Session" WHERE (${hashes}) OR (${users}) ORDER BY "tokenHash" FOR UPDATE` : undefined;
  },
  deleteSessions(rows: readonly CleanupSession[]) {
    return rows.length ? Prisma.sql`DELETE FROM public."Session" WHERE ${Prisma.join(rows.map((row) => Prisma.sql`("tokenHash" = ${row.tokenHash} AND "userId" IS NOT DISTINCT FROM ${row.userId}::uuid)`), ' OR ')} RETURNING "tokenHash", "userId"` : undefined;
  },
  deleteUsers(rows: readonly OwnedUser[]) {
    return rows.length ? Prisma.sql`DELETE FROM public."User" u WHERE (${Prisma.join(rows.map((row) => Prisma.sql`(u.id = ${row.id}::uuid AND u.email = ${row.email})`), ' OR ')}) AND NOT EXISTS (SELECT 1 FROM public."Session" s WHERE s."userId" = u.id) RETURNING id, email` : undefined;
  }
};

export function prismaCleanupRepository(database: ReturnType<typeof createGuardedTransactions>): CleanupRepository {
  async function lock(tx: Prisma.TransactionClient, targets: Targets) {
    const users = cleanupSql.lockUsers(targets.users);
    const sessions = cleanupSql.lockSessions(targets);
    return { users: users ? await tx.$queryRaw(users) : [], sessions: sessions ? await tx.$queryRaw(sessions) : [] };
  }
  return {
    lock,
    async deleteSessions(tx, rows) { const query = cleanupSql.deleteSessions(rows); return query ? tx.$queryRaw(query) : []; },
    async deleteUsers(tx, rows) { const query = cleanupSql.deleteUsers(rows); return query ? tx.$queryRaw(query) : []; },
    async verifyAbsent(targets) {
      return database.$transaction(async (tx) => {
        const result = await lock(tx, targets);
        return Array.isArray(result.users) && result.users.length === 0 && Array.isArray(result.sessions) && result.sessions.length === 0;
      });
    }
  };
}
