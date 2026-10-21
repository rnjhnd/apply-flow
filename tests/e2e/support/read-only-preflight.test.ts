import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runPreflightCommand } from './read-only-preflight.js';
import { requireLivePhase } from './execution.js';

describe('B2 Gate A command remains offline', () => {
  it('returns fixed failure without reading migration bytes or constructing a client/socket', async () => {
    // Actual construction/network tripwires for this entry point also run in
    // discovery.test.ts. No gate is mocked open in this suite.
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runPreflightCommand()).toBe(1);
      expect(log).toHaveBeenCalledExactlyOnceWith('Read-only preflight disabled: Gate B approval and review are required.');
    } finally { log.mockRestore(); }
  });
  it.each(['preflight', 'fixtures', 'smoke', 'full'] as const)('retains disabled %s execution regardless of environment flags', (phase) => {
    vi.stubEnv('APPLYFLOW_E2E_APPROVED', 'true'); vi.stubEnv('APPLYFLOW_PREFLIGHT_APPROVED', 'true');
    try { expect(() => requireLivePhase(phase)).toThrow('disabled'); } finally { vi.unstubAllEnvs(); }
  });
  it('uses the approved single installed driver version and stream factory contract', () => {
    // Static inspection only: no actual pg client/socket is constructed here.
    const metadata = JSON.parse(readFileSync(new URL('../../../node_modules/pg/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(metadata.version).toBe('8.23.1');
    const connection = readFileSync(new URL('../../../node_modules/pg/lib/connection.js', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../../node_modules/pg/lib/client.js', import.meta.url), 'utf8');
    expect(client).toContain('stream: c.stream');
    expect(connection).toContain('this.stream = config.stream || getStream(config.ssl)');
    expect(connection).toContain('this.stream = this.stream(config)');
    expect(connection).toContain('this.stream.connect(port, host)');
    expect(connection).toContain('this.attachListeners(this.stream)');
  });
  it('adds only the disabled preflight script without changing existing live entry points', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['test:e2e:preflight']).toBe('node --import tsx tests/e2e/support/read-only-preflight.ts');
    expect(manifest.scripts['test:e2e']).toBe('node --import tsx tests/e2e/support/run.ts');
  });
});
