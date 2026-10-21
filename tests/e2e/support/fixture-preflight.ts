import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';

export function runFixtureInspection(output: (line: string) => void): number {
  try { output('APPLYFLOW_FIXTURES DISABLED: B3C1 read-only Prisma inspection requires separate approval.'); } catch { /* No raw diagnostic fallback. */ }
  return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runFixtureInspection((line) => { writeSync(2, `${line}\n`); });
}
