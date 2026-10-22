import { describe, expect, it, vi } from 'vitest';
import { requireLivePhase, responseGate, sanitizedResult } from './execution.js';
import { requireLiveRuntime } from './fixtures.js';
import { createChildRecorder, type Acknowledgment } from './child-protocol.js';
import { owner, email, hash, memoryIo } from './b1-fakes.js';

describe('B1 disabled execution, privacy, and deterministic failure gates', () => {
  it.each(['preflight', 'fixtures', 'smoke', 'full'] as const)('cannot enable live %s via an environment approval flag', (phase) => {
    vi.stubEnv('APPLYFLOW_E2E_APPROVED', 'true');
    try {
      expect(() => requireLivePhase(phase)).toThrow('disabled');
      expect(requireLiveRuntime).toThrow('not implemented or enabled');
    } finally { vi.unstubAllEnvs(); }
  });
  it('the existing live entry point exits unsuccessfully without loading services', async () => {
    const previous = process.exitCode; const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await import('./run.js'); expect(process.exitCode).toBe(1);
      expect(log).toHaveBeenCalledWith('Live E2E execution is unavailable: Stage 2C.3B approval and implementation are required.');
    } finally { process.exitCode = previous; log.mockRestore(); }
  });
  it('emits only a numeric case identifier and an allowlisted outcome', () => {
    expect(sanitizedResult(3, 'failed')).toBe('{"case":3,"outcome":"failed"}');
    for (const secret of ['password=never-log', 'postgresql://user:secret@host/db', 'Cookie: session=raw', 'csrf=proof']) {
      expect(() => sanitizedResult(1, secret)).toThrow(/^Invalid diagnostic metadata\.$/);
    }
    expect(() => sanitizedResult(NaN, 'failed')).toThrow(); expect(() => sanitizedResult(-1, 'failed')).toThrow();
  });
  it('holds injected responses until explicit release, without timers or retry', async () => {
    const gate = responseGate(); const done = vi.fn();
    const pending = gate.waiting.then(done); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    gate.release(); gate.release(); await pending; expect(done).toHaveBeenCalledOnce();
  });
  it('rejects raw credential/token metadata without journal append or public leak', () => {
    for (const extra of [{ password: 'secret password' }, { token: 'raw-session-token' }, { csrfToken: 'raw-proof' }, { databaseUrl: 'secret-url' }]) {
      const io = memoryIo(); const recorder = createChildRecorder(owner, io, async () => undefined, () => undefined);
      const initial = io.contents;
      expect(() => recorder.record({ kind: 'tokenHash', value: hash, ...extra })).toThrow(/^Fixture evidence requires review\.$/);
      expect(io.contents).toBe(initial);
    }
  });
  it('acknowledgment output contains no request credentials or raw authentication response', async () => {
    const io = memoryIo(); const send = vi.fn<(ack: Acknowledgment) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = createChildRecorder(owner, io, send, () => undefined);
    await recorder.intent({ type: 'email-intent', ...owner, email, messageId: owner.runId });
    expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual(['digest', 'messageId', 'runId', 'sequence', 'testId', 'type']);
  });
});
