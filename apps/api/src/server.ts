import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { parseAuthConfig } from './config/auth.js';
import { openRuntimeDatabase } from './db/client.js';
import { createSessionService } from './modules/auth/sessions.js';
import { startSessionCleanup } from './modules/auth/cleanup.js';
import { createPasswordService } from './modules/auth/passwords.js';
import { createAuthenticationService } from './modules/auth/authentication.js';

async function main() {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) loadEnvFile(envPath);
  const env = parseEnv(process.env);
  const config = parseAuthConfig(process.env);
  const database = await openRuntimeDatabase(process.env);
  try {
    const sessions = createSessionService(database.client);
    const passwords = await createPasswordService();
    const authentication = createAuthenticationService(database.client, passwords);
    const app = createApp(env, { config, sessions, authentication });
    const stopCleanup = startSessionCleanup(sessions);
    const server = app.listen(env.PORT, env.HOST, () => {
      console.info(`ApplyFlow API listening at http://${env.HOST}:${env.PORT}`);
    });
    server.on('error', () => {
      console.error('Server failed to start.');
      void stopCleanup().then(() => database.client.$disconnect()).catch(() => {
        console.error('Server resource cleanup failed.');
      });
      process.exitCode = 1;
    });
    let shuttingDown = false;
    function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const cleanupStopped = stopCleanup();
      server.close((error) => {
        // Explicit exit also releases the IPC channel held by the development watcher.
        void cleanupStopped.then(() => database.client.$disconnect()).then(() => process.exit(error ? 1 : 0), () => process.exit(1));
      });
      setTimeout(() => server.closeAllConnections(), 10_000).unref();
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    await database.client.$disconnect();
    throw error;
  }
}

void main().catch(() => {
  // Do not print database URLs, driver errors, cookies, or configuration values.
  console.error('API startup failed. Check configuration, database availability, and build output.');
  process.exitCode = 1;
});
