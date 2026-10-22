import { defineConfig } from 'prisma/config';
import { loadLocalEnvironment } from './src/config/load-env.ts';
import { readDatabaseTarget } from './src/config/database.ts';

// Prisma 7.10.1's schema engine requires datasource metadata even for an
// empty-to-schema diff. Offline commands use an inert URL, never local credentials.
// Only the guarded migration wrapper selects a live datasource.
const selected = process.env.PRISMA_MIGRATION_TARGET;
if (selected !== undefined && selected !== 'development' && selected !== 'test') {
  throw new Error('Invalid local migration target.');
}
if (selected) loadLocalEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: selected
      ? readDatabaseTarget(selected, process.env).connectionString
      : 'postgresql://offline:offline@127.0.0.1:1/offline'
  }
});
