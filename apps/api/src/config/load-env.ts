import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

export const localEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));

export function loadLocalEnvironment(): void {
  if (existsSync(localEnvPath)) loadEnvFile(localEnvPath);
}
