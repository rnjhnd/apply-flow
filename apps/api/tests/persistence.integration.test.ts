import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase } from '../src/db/client.js';
import type { Prisma } from '../src/generated/prisma/client.ts';

const approvedSqlHash = '98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840';
const fixturePrefix = `checkpoint2a-${randomUUID()}-`;
const ownedUserIds = new Set<string>();
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;

function testClient() {
  requireTestDatabaseTarget(process.env);
  if (!database) throw new Error('The guarded test connection is not initialized.');
  return database.client;
}

function userData() {
  return {
    email: `${fixturePrefix}${randomUUID()}@example.invalid`,
    passwordHash: 'persistence-fixture-only-not-an-authentication-hash'
  };
}

function sessionData() {
  return {
    tokenHash: randomBytes(32).toString('hex'),
    csrfToken: randomBytes(32).toString('hex'),
    expiresAt: new Date('2030-01-01T00:00:00.000Z')
  };
}

async function assertTestIdentity(transaction: Prisma.TransactionClient): Promise<void> {
  const target = requireTestDatabaseTarget(process.env);
  const identities = await transaction.$queryRaw<Array<{ database: string; username: string }>>`
    SELECT current_database()::text AS database, current_user::text AS username
  `;
  assertDatabaseIdentity(target, identities[0]);
}

async function rolledBack(work: (transaction: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  const rollback = new Error('Intentional fixture rollback');
  await expect(testClient().$transaction(async (transaction) => {
    await assertTestIdentity(transaction);
    await work(transaction);
    throw rollback;
  })).rejects.toBe(rollback);
}

beforeAll(async () => {
  loadLocalEnvironment();
  // Fail before connecting or writing: no development fallback or NODE_ENV override.
  requireTestDatabaseTarget(process.env);
  const sql = readFileSync(new URL('../prisma/migrations/0001_init_auth/migration.sql', import.meta.url));
  expect(createHash('sha256').update(sql).digest('hex')).toBe(approvedSqlHash);
  database = await openLocalDatabase('test', process.env);
  const history = await testClient().$queryRaw<Array<{
    migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null;
  }>>`SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations`;
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    migration_name: '0001_init_auth', checksum: approvedSqlHash,
    finished_at: expect.any(Date), rolled_back_at: null
  });
});

afterEach(async () => {
  if (!ownedUserIds.size) return;
  await testClient().$transaction(async (transaction) => {
    await assertTestIdentity(transaction);
    // Never delete unrelated fixtures, existing rows, or development data.
    await transaction.user.deleteMany({
      where: { id: { in: [...ownedUserIds] }, email: { startsWith: fixturePrefix } }
    });
    expect(await transaction.user.count({ where: { id: { in: [...ownedUserIds] } } })).toBe(0);
    expect(await transaction.session.count({ where: { userId: { in: [...ownedUserIds] } } })).toBe(0);
  });
  ownedUserIds.clear();
});

afterAll(async () => { await database?.client.$disconnect(); });

describe('approved PostgreSQL schema', () => {
  it('connects only to the dedicated test database and user', async () => {
    expect(database?.target).toMatchObject({
      name: 'test', host: '127.0.0.1', port: '5433', database: 'applyflow_test', username: 'applyflow_test'
    });
    await testClient().$transaction(assertTestIdentity);
  });

  it('rejects a development URL before opening a test connection', async () => {
    await expect(openLocalDatabase('test', {
      ...process.env, TEST_DATABASE_URL: 'postgresql://applyflow_dev:fixture-only@127.0.0.1:15432/applyflow_dev'
    })).rejects.toThrow(/TEST_DATABASE_URL must explicitly target/);
  });

  it('has the reviewed column types, nullability, and database defaults', async () => {
    const columns = await testClient().$queryRaw<Array<{
      table_name: string; column_name: string; udt_name: string; is_nullable: string;
      character_maximum_length: number | null; datetime_precision: number | null; column_default: string | null;
    }>>`
      SELECT table_name, column_name, udt_name, is_nullable, character_maximum_length,
             datetime_precision, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('User', 'Session')
    `;
    expect(columns).toHaveLength(12);
    for (const table of ['User', 'Session']) {
      expect(columns).toContainEqual(expect.objectContaining({
        table_name: table, column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null
      }));
    }
    expect(columns).toContainEqual(expect.objectContaining({
      table_name: 'User', column_name: 'email', udt_name: 'varchar', character_maximum_length: 254
    }));
    expect(columns).toContainEqual(expect.objectContaining({
      table_name: 'User', column_name: 'passwordHash', udt_name: 'text', is_nullable: 'NO'
    }));
    expect(columns).toContainEqual(expect.objectContaining({
      table_name: 'Session', column_name: 'userId', udt_name: 'uuid', is_nullable: 'YES'
    }));
    for (const column_name of ['tokenHash', 'csrfToken']) {
      expect(columns).toContainEqual(expect.objectContaining({
        table_name: 'Session', column_name, udt_name: 'bpchar', character_maximum_length: 64, is_nullable: 'NO'
      }));
    }
    const timestamps = columns.filter((column) => column.udt_name === 'timestamptz');
    expect(timestamps).toHaveLength(5);
    expect(timestamps.every((column) => column.datetime_precision === 3 && column.is_nullable === 'NO')).toBe(true);
    expect(timestamps.filter((column) => column.column_default === 'CURRENT_TIMESTAMP')).toHaveLength(3);
  });

  it('has all six valid primary, unique, and lookup indexes', async () => {
    const indexes = await testClient().$queryRaw<Array<{ name: string; unique: boolean; valid: boolean; columns: string[] }>>`
      SELECT index_class.relname AS name, index.indisunique AS unique, index.indisvalid AS valid,
        array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns
      FROM pg_index index
      JOIN pg_class table_class ON table_class.oid = index.indrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_class index_class ON index_class.oid = index.indexrelid
      CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key(number, ordinality)
      JOIN pg_attribute attribute ON attribute.attrelid = table_class.oid AND attribute.attnum = key.number
      WHERE namespace.nspname = 'public' AND table_class.relname IN ('User', 'Session')
      GROUP BY index_class.relname, index.indisunique, index.indisvalid ORDER BY index_class.relname
    `;
    expect(indexes).toEqual([
      { name: 'Session_expiresAt_idx', unique: false, valid: true, columns: ['expiresAt'] },
      { name: 'Session_pkey', unique: true, valid: true, columns: ['id'] },
      { name: 'Session_tokenHash_key', unique: true, valid: true, columns: ['tokenHash'] },
      { name: 'Session_userId_idx', unique: false, valid: true, columns: ['userId'] },
      { name: 'User_email_key', unique: true, valid: true, columns: ['email'] },
      { name: 'User_pkey', unique: true, valid: true, columns: ['id'] }
    ]);
  });

  it('has a validated cascading foreign key and both primary keys', async () => {
    const constraints = await testClient().$queryRaw<Array<{ name: string; validated: boolean; definition: string }>>`
      SELECT constraint_info.conname AS name, constraint_info.convalidated AS validated,
        pg_get_constraintdef(constraint_info.oid) AS definition
      FROM pg_constraint constraint_info JOIN pg_class table_class ON table_class.oid = constraint_info.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'public' AND table_class.relname IN ('User', 'Session')
      ORDER BY constraint_info.conname
    `;
    expect(constraints).toEqual([
      { name: 'Session_pkey', validated: true, definition: 'PRIMARY KEY (id)' },
      { name: 'Session_userId_fkey', validated: true,
        definition: 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE' },
      { name: 'User_pkey', validated: true, definition: 'PRIMARY KEY (id)' }
    ]);
  });
});

describe('isolated persistence behavior', () => {
  it('generates User and Session UUIDs through Prisma and reads their relationship', async () => {
    await rolledBack(async (transaction) => {
      const user = await transaction.user.create({ data: userData() });
      const session = await transaction.session.create({ data: { ...sessionData(), userId: user.id } });
      expect(user.id).toMatch(uuidV4);
      expect(session.id).toMatch(uuidV4);
      expect(session.id).not.toBe(user.id);
      const persisted = await transaction.user.findUniqueOrThrow({ where: { id: user.id }, include: { sessions: true } });
      expect(persisted.sessions).toEqual([session]);
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
      expect(session.lastSeenAt).toBeInstanceOf(Date);
    });
  });

  it('permits multiple anonymous sessions without a user', async () => {
    await rolledBack(async (transaction) => {
      const first = await transaction.session.create({ data: sessionData() });
      const second = await transaction.session.create({ data: sessionData() });
      expect(first.id).toMatch(uuidV4);
      expect(second.id).not.toBe(first.id);
      expect(first.userId).toBeNull();
      expect(second.userId).toBeNull();
    });
  });

  it('persists a committed graph visible from another guarded test connection', async () => {
    const id = randomUUID();
    ownedUserIds.add(id);
    const saved = await testClient().$transaction(async (transaction) => {
      await assertTestIdentity(transaction);
      return transaction.user.create({ data: { id, ...userData(), sessions: { create: sessionData() } }, include: { sessions: true } });
    });
    const other = await openLocalDatabase('test', process.env);
    try {
      expect(await other.client.user.findUniqueOrThrow({ where: { id }, include: { sessions: true } })).toEqual(saved);
    } finally { await other.client.$disconnect(); }
  });

  it('rolls back both user and session after an exception', async () => {
    const userId = randomUUID();
    ownedUserIds.add(userId);
    const sessionId = randomUUID();
    const failure = new Error('Simulated operation failure');
    await expect(testClient().$transaction(async (transaction) => {
      await assertTestIdentity(transaction);
      await transaction.user.create({ data: { id: userId, ...userData() } });
      await transaction.session.create({ data: { id: sessionId, userId, ...sessionData() } });
      throw failure;
    })).rejects.toBe(failure);
    expect(await testClient().user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await testClient().session.findUnique({ where: { id: sessionId } })).toBeNull();
  });

  it('leaves no partial user or session when session uniqueness fails in a transaction', async () => {
    const userId = randomUUID();
    ownedUserIds.add(userId);
    const data = sessionData();
    await expect(testClient().$transaction(async (transaction) => {
      await assertTestIdentity(transaction);
      await transaction.user.create({ data: { id: userId, ...userData() } });
      await transaction.session.create({ data: { ...data, userId } });
      await transaction.session.create({ data: { ...data, userId } });
    })).rejects.toMatchObject({ code: 'P2002' });
    expect(await testClient().user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await testClient().session.findUnique({ where: { tokenHash: data.tokenHash } })).toBeNull();
  });

  it('rejects duplicate stored email values', async () => {
    await rolledBack(async (transaction) => {
      const data = userData();
      await transaction.user.create({ data });
      await expect(transaction.user.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  it('rejects duplicate session token hashes', async () => {
    await rolledBack(async (transaction) => {
      const data = sessionData();
      await transaction.session.create({ data });
      await expect(transaction.session.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  it('rejects a session referencing a nonexistent user', async () => {
    await rolledBack(async (transaction) => {
      await expect(transaction.session.create({ data: { ...sessionData(), userId: randomUUID() } }))
        .rejects.toMatchObject({ code: 'P2003' });
    });
  });

  it('deletes a fixture user and related sessions while retaining an anonymous session', async () => {
    await rolledBack(async (transaction) => {
      const user = await transaction.user.create({
        data: { ...userData(), sessions: { create: [sessionData(), sessionData()] } }, include: { sessions: true }
      });
      const anonymous = await transaction.session.create({ data: sessionData() });
      await transaction.user.delete({ where: { id: user.id } });
      expect(await transaction.session.count({ where: { id: { in: user.sessions.map((session) => session.id) } } })).toBe(0);
      expect(await transaction.session.findUnique({ where: { id: anonymous.id } })).toEqual(anonymous);
    });
  });

  it('cascades a fixture primary-key update to its session foreign key', async () => {
    await rolledBack(async (transaction) => {
      const user = await transaction.user.create({ data: userData() });
      const session = await transaction.session.create({ data: { ...sessionData(), userId: user.id } });
      const replacementId = randomUUID();
      await transaction.user.update({ where: { id: user.id }, data: { id: replacementId } });
      expect((await transaction.session.findUniqueOrThrow({ where: { id: session.id } })).userId).toBe(replacementId);
    });
  });
});
