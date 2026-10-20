import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

const env = parseEnv(process.env);
const server = createApp(env).listen(env.PORT, env.HOST, () => {
  console.info(`ApplyFlow API listening at http://${env.HOST}:${env.PORT}`);
});

server.on('error', (error) => {
  console.error(`Server failed to start: ${error.message}`);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close((error) => {
    // Explicit exit also releases the IPC channel held by the development watcher.
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => server.closeAllConnections(), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
