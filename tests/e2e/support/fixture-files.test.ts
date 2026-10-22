import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileOperationLedger } from './fixture-files.js';
import { owner } from './b1-fakes.js';

const fs = vi.hoisted(() => ({ mkdirSync: vi.fn(), openSync: vi.fn(() => 7), writeSync: vi.fn(() => 1),
  fsyncSync: vi.fn(), closeSync: vi.fn(), readFileSync: vi.fn(() => 'recorded') }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), ...fs }));
afterEach(() => { vi.clearAllMocks(); });

describe('B3 operation-ledger fixed-path filesystem adapter (mocked fs only)', () => {
  it('constructs without IO, strips owner context, and writes complete bytes before fsync/close', () => {
    const extended = { ...owner, databaseUrl: 'private-url', other: 'private' };
    const io = fileOperationLedger(extended);
    expect(fs.openSync).not.toHaveBeenCalled(); io.append('abc\n', true);
    expect(fs.writeSync).toHaveBeenCalledTimes(4);
    expect(fs.openSync).toHaveBeenCalledWith(expect.stringMatching(/\.cache[\\/]e2e[\\/].*\.operations\.jsonl$/), 'wx', 0o600);
    expect(fs.writeSync.mock.invocationCallOrder.at(-1)!).toBeLessThan(fs.fsyncSync.mock.invocationCallOrder[0]!);
    expect(fs.fsyncSync.mock.invocationCallOrder[0]!).toBeLessThan(fs.closeSync.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(fs.openSync.mock.calls)).not.toContain('private');
  });
  it('does not touch the filesystem for malformed owner identifiers', () => {
    expect(() => fileOperationLedger({ ...owner, runId: '../escape' })).toThrow('Invalid'); expect(fs.openSync).not.toHaveBeenCalled();
  });
  it.each(['write', 'fsync'])('closes its descriptor after %s failure without claiming persistence', (kind) => {
    if (kind === 'write') fs.writeSync.mockReturnValueOnce(0);
    else fs.fsyncSync.mockImplementationOnce(() => { throw new Error('Injected persistence failure'); });
    expect(() => fileOperationLedger(owner).append('abc\n', true)).toThrow(); expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(7);
  });
});
