import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileJournalIo } from './journal.js';

const fs = vi.hoisted(() => ({ mkdirSync: vi.fn(), openSync: vi.fn(), writeSync: vi.fn(),
  fsyncSync: vi.fn(), closeSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:fs', () => fs);
const owner = { runId: randomUUID(), testId: randomUUID() };
beforeEach(() => { vi.resetAllMocks(); fs.openSync.mockReturnValue(11); });

describe('fixed-path journal durability with mocked filesystem only', () => {
  it('uses exclusive creation, a private mode, complete partial-write handling, fsync, then close', () => {
    const order: string[] = [];
    const chunks: Buffer[] = [];
    fs.writeSync.mockImplementation((_fd: number, bytes: Buffer, offset: number, length: number) => {
      const n = Math.min(length, 3); chunks.push(bytes.subarray(offset, offset + n)); order.push('write'); return n;
    });
    fs.fsyncSync.mockImplementation(() => { order.push('sync'); });
    fs.closeSync.mockImplementation(() => { order.push('close'); });
    fileJournalIo(owner).append('fixture intent\n', true);
    expect(Buffer.concat(chunks).toString()).toBe('fixture intent\n');
    expect(order.slice(-2)).toEqual(['sync', 'close']);
    expect(fs.openSync).toHaveBeenCalledWith(fileURLToPath(new URL(`../../../.cache/e2e/${owner.runId}/${owner.testId}.jsonl`, import.meta.url)), 'wx', 0o600);
    expect(fs.openSync.mock.calls[0]?.[0]).toContain(`${owner.testId}.jsonl`);
  });
  it('appends rather than truncating, and uses only the same fixed journal on reads', () => {
    fs.writeSync.mockImplementation((_fd: number, _bytes: Buffer, _offset: number, length: number) => length);
    const io = fileJournalIo(owner); io.append('line\n', false); io.read();
    expect(fs.openSync.mock.calls[0]?.[1]).toBe('a');
    expect(fs.readFileSync).toHaveBeenCalledWith(fs.openSync.mock.calls[0]?.[0], 'utf8');
  });
  it.each(['write', 'sync'])('propagates %s failure and closes the descriptor', (phase) => {
    fs.writeSync.mockImplementation((_fd: number, _bytes: Buffer, _offset: number, length: number) => length);
    fs[phase === 'write' ? 'writeSync' : 'fsyncSync'].mockImplementation(() => { throw new Error('Mock journal failure'); });
    expect(() => fileJournalIo(owner).append('line\n', false)).toThrow('journal failure');
    expect(fs.closeSync).toHaveBeenCalledWith(11);
  });
  it('rejects zero-byte writes without claiming durability', () => {
    fs.writeSync.mockReturnValue(0);
    expect(() => fileJournalIo(owner).append('line\n', false)).toThrow('Incomplete');
    expect(fs.fsyncSync).not.toHaveBeenCalled(); expect(fs.closeSync).toHaveBeenCalledWith(11);
  });
  it('rejects untrusted path material before any filesystem operation', () => {
    expect(() => fileJournalIo({ ...owner, testId: '../../outside' })).toThrow();
    expect(fs.mkdirSync).not.toHaveBeenCalled(); expect(fs.openSync).not.toHaveBeenCalled();
  });
});
