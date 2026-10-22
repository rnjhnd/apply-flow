import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileEvidence } from './evidence-files.js';
import { acquireLease } from './safety-io.js';
const owner = { runId: '11111111-1111-4111-8111-111111111111', testId: '22222222-2222-4222-8222-222222222222' };

const fs = vi.hoisted(() => ({ mkdirSync: vi.fn(), openSync: vi.fn(), writeSync: vi.fn(), fsyncSync: vi.fn(),
  closeSync: vi.fn(), readFileSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), ...fs }));
beforeEach(() => {
  vi.resetAllMocks(); fs.openSync.mockReturnValue(7);
  fs.writeSync.mockImplementation((_fd: number, _bytes: Buffer, _offset: number, length: number) => length);
});
describe('B1 fixed-path evidence durability with mocked filesystem only', () => {
  it('does no I/O during construction and rejects untrusted owner/path metadata', () => {
    const evidence = fileEvidence(owner); expect(fs.mkdirSync).not.toHaveBeenCalled(); expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(() => fileEvidence({ ...owner, testId: '../outside' })).toThrow();
    expect(() => evidence.leases.read('../outside')).toThrow('Unauthorized');
    expect(() => evidence.leases.claim('active-run', 'secret')).toThrow('Unexpected'); expect(fs.openSync).not.toHaveBeenCalled();
  });
  it('creates the ledger exclusively in a private fixed file and fsyncs complete writes', () => {
    const io = fileEvidence(owner).ledger;
    fs.writeSync.mockImplementation((_fd: number, _bytes: Buffer, _offset: number, length: number) => Math.min(length, 3));
    io.append('evidence\n', true);
    expect(fs.openSync).toHaveBeenCalledWith(expect.stringContaining(`${owner.testId}.finalization.jsonl`), 'wx', 0o600);
    expect(fs.writeSync).toHaveBeenCalledTimes(3); expect(fs.fsyncSync).toHaveBeenCalledWith(7); expect(fs.closeSync).toHaveBeenCalledWith(7);
    expect(fs.fsyncSync.mock.invocationCallOrder[0]!).toBeLessThan(fs.closeSync.mock.invocationCallOrder[0]!);
    io.append('next\n', false); expect(fs.openSync.mock.calls.at(-1)?.[1]).toBe('a');
  });
  it.each(['write', 'fsync'])('retains failure evidence and closes its descriptor after %s failure', (stage) => {
    fs[stage === 'write' ? 'writeSync' : 'fsyncSync'].mockImplementation(() => { throw new Error('injected persistence failure'); });
    expect(() => fileEvidence(owner).ledger.append('line\n', false)).toThrow('persistence');
    expect(fs.closeSync).toHaveBeenCalledOnce(); expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
  it('rejects zero-byte writes without claiming durability', () => {
    fs.writeSync.mockReturnValue(0); expect(() => fileEvidence(owner).ledger.append('line\n', true)).toThrow('Incomplete');
    expect(fs.fsyncSync).not.toHaveBeenCalled(); expect(fs.closeSync).toHaveBeenCalledOnce();
  });
  it('releases only an exact held lease; a conflicting or missing lease is never removed', () => {
    const evidence = fileEvidence(owner); const lease = acquireLease(evidence.leases, owner, 'run');
    fs.readFileSync.mockReturnValue('conflict'); expect(() => lease.release()).toThrow('changed'); expect(fs.unlinkSync).not.toHaveBeenCalled();
    const contents = JSON.stringify({ version: 1, kind: 'run', ...owner }); fs.readFileSync.mockReturnValue(contents);
    lease.release(); expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('active-run.lease'));
  });
  it('serializes only canonical owner fields when file evidence receives an extended context', () => {
    const source = { ...owner, databaseUrl: 'private-url-sentinel', arbitrary: 'arbitrary-sentinel' };
    const evidence = fileEvidence(source); source.runId = owner.testId;
    acquireLease(evidence.leases, owner, 'run');
    const written = fs.writeSync.mock.calls.map((call) => (call[1] as Buffer).toString()).join('');
    expect(JSON.parse(written)).toEqual({ version: 1, kind: 'run', runId: owner.runId, testId: owner.testId });
    expect(written).not.toContain('sentinel'); expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
