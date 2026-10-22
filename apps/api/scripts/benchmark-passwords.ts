import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { ARGON2_PARAMETERS, createPasswordService } from '../src/modules/auth/passwords.js';

const service = await createPasswordService();
const password = 'Benchmark fixture only, never an account credential';
const digest = await service.hash(password);
await service.verify(digest, password);
async function measure(operation: () => Promise<unknown>) {
  const milliseconds: number[] = [];
  for (let index = 0; index < 10; index++) {
    const start = performance.now();
    await operation();
    milliseconds.push(performance.now() - start);
  }
  milliseconds.sort((left, right) => left - right);
  return { samples: milliseconds.length, minMs: Number(milliseconds[0]!.toFixed(2)),
    medianMs: Number(((milliseconds[4]! + milliseconds[5]!) / 2).toFixed(2)), p95Ms: Number(milliseconds[9]!.toFixed(2)) };
}
console.info(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  parameters: ARGON2_PARAMETERS, warmupExcluded: true,
  hash: await measure(() => service.hash(password)),
  verify: await measure(() => service.verify(digest, password)),
  unknownAccount: await measure(() => service.verify(null, password)) }, null, 2));
