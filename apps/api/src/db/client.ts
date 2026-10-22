import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { readProductionDatabaseTarget } from '../config/production-database.js';
import {
  assertDatabaseIdentity, DatabaseConfigurationError, readDatabaseTarget,
  type DatabaseEnvironment, type DatabaseTargetName
} from '../config/database.js';

export async function openLocalDatabase(name: DatabaseTargetName, environment: DatabaseEnvironment) {
  const target = readDatabaseTarget(name, environment);
  const adapter = new PrismaPg({
    connectionString: target.connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    options: '-c search_path=public'
  });
  const client = new PrismaClient({ adapter });
  try {
    await client.$connect();
    const identities = await client.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database()::text AS database, current_user::text AS username
    `;
    assertDatabaseIdentity(target, identities[0]);
    return { client, target };
  } catch (error) {
    await client.$disconnect();
    if (error instanceof DatabaseConfigurationError) throw error;
    throw new DatabaseConfigurationError(`Could not connect to the approved ${name} database; check Docker and the ignored environment file.`);
  }
}

export async function openRuntimeDatabase(environment: DatabaseEnvironment) {
  if (process.env.NODE_ENV === 'test' && environment.NODE_ENV !== 'test') {
    throw new DatabaseConfigurationError('Test processes cannot select another runtime environment.');
  }
  if (environment.NODE_ENV !== 'production') {
    const name = environment.NODE_ENV === 'test' ? 'test' : 'development';
    return openLocalDatabase(name, environment);
  }
  const target = readProductionDatabaseTarget(environment);
  const adapter = new PrismaPg({ connectionString: target.connectionString, ssl: target.ssl,
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, options: '-c search_path=public' });
  const client = new PrismaClient({ adapter });
  try {
    await client.$connect();
    const identities = await client.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database()::text AS database, current_user::text AS username
    `;
    if (identities[0]?.database !== target.database || identities[0].username !== target.username) {
      throw new DatabaseConfigurationError('Connected runtime database/user does not match the configuration.');
    }
    return { client, target };
  } catch {
    await client.$disconnect();
    throw new DatabaseConfigurationError('Production database connection or identity validation failed.');
  }
}
