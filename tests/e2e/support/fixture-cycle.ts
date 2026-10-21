import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';

export function runFixtureCycle(output: (line: string) => void): number {
  try { output('APPLYFLOW_FIXTURES DISABLED: B3C2 fixture creation and cleanup require separate approval.'); } catch { /* No raw diagnostic fallback. */ }
  return 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runFixtureCycle((line) => { writeSync(2, `${line}\n`); });
}
