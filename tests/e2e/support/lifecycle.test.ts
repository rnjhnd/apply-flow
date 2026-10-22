import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindLoopback, ownChild, type OwnedChild } from './lifecycle.js';

const runId = randomUUID();
const timing = { startupMs: 100, graceMs: 20, exitMs: 30 };
function fixture() {
  const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() });
  const spawn = vi.fn<() => OwnedChild>().mockReturnValue(child);
  const owned = ownChild(spawn, runId, timing);
  return { child, spawn, owned };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('owned process lifecycle with controlled mocks only', () => {
  it('stop followed immediately by readiness rejects admission and shares repeated shutdown requests', async () => {
    const { child, owned } = fixture();
    const rejected = expect(owned.ready).rejects.toThrow('shutdown');
    const stopping = owned.stop();
    child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 45000 });
    expect(owned.isHealthy()).toBe(false); expect(owned.hasExited()).toBe(false);
    expect(owned.stop()).toBe(stopping); child.emit('disconnect'); child.emit('disconnect');
    expect(owned.stop()).toBe(stopping);
    await rejected; expect(child.send).toHaveBeenCalledOnce();
    child.emit('exit', 0); await stopping;
    expect(child.kill).not.toHaveBeenCalled(); expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes health synchronously when a ready child is asked to stop', async () => {
    const { child, owned } = fixture();
    child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 45000 }); await owned.ready;
    expect(owned.isHealthy()).toBe(true);
    const stopping = owned.stop();
    expect(owned.isHealthy()).toBe(false); expect(owned.hasExited()).toBe(false);
    expect(owned.stop()).toBe(stopping); await Promise.resolve();
    expect(child.send).toHaveBeenCalledOnce(); child.emit('exit', 0); await stopping;
    expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('skips escalation when exit arrives between grace timeout resolution and the kill continuation', async () => {
    const { child, owned } = fixture();
    child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 45000 }); await owned.ready;
    const stopping = owned.stop(); await Promise.resolve();
    expect(child.send).toHaveBeenCalledOnce(); expect(owned.hasExited()).toBe(false);
    // Synchronous clock advancement resolves the timeout without draining promise
    // reactions. Exit then lands between the race resolution and escalation.
    vi.advanceTimersByTime(timing.graceMs);
    queueMicrotask(() => child.emit('exit', 0));
    await stopping;
    expect(owned.hasExited()).toBe(true); expect(child.kill).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('accepts only the owned readiness marker and loopback port, never an existing URL', async () => {
    const { child, spawn, owned } = fixture();
    child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 49567 });
    await expect(owned.ready).resolves.toEqual({ origin: 'http://127.0.0.1:49567' });
    expect(spawn).toHaveBeenCalledOnce(); expect(owned.isHealthy()).toBe(true);
    const stopping = owned.stop(); await Promise.resolve();
    expect(child.send).toHaveBeenCalledWith({ type: 'shutdown', runId });
    child.emit('exit', 0); await stopping;
    expect(owned.hasExited()).toBe(true); expect(owned.isHealthy()).toBe(false);
    expect(child.kill).not.toHaveBeenCalled(); expect(child.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    { type: 'ready', runId: randomUUID(), host: '127.0.0.1', port: 45000 },
    { type: 'ready', runId, host: 'localhost', port: 45000 },
    { type: 'ready', runId, host: '127.0.0.1', port: 0 },
    { type: 'ready', runId, host: '127.0.0.1', port: 45000, cookie: 'forbidden' }
  ])('rejects unexpected readiness %# and requests bounded shutdown', async (message) => {
    const { child, owned } = fixture(); const rejected = expect(owned.ready).rejects.toThrow('identity');
    child.emit('message', message); await rejected;
    expect(child.send).toHaveBeenCalledOnce(); child.emit('exit', 1); await owned.stop();
    expect(owned.hasExited()).toBe(true);
  });
  it('startup timeout initiates graceful shutdown and then kills only the owned child', async () => {
    const { child, owned } = fixture(); const rejected = expect(owned.ready).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100); await rejected; expect(child.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20); expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', 1); await owned.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('IPC disconnect before readiness fails closed and still waits for observed exit', async () => {
    const { child, owned } = fixture(); const rejected = expect(owned.ready).rejects.toThrow('disconnected');
    child.emit('disconnect'); await rejected; expect(owned.hasExited()).toBe(false);
    child.emit('exit', 1); await owned.stop(); expect(owned.hasExited()).toBe(true);
  });
  it('IPC disconnect after readiness invalidates health and starts shutdown', async () => {
    const { child, owned } = fixture(); child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 45000 });
    await owned.ready; child.emit('disconnect');
    expect(owned.isHealthy()).toBe(false); await Promise.resolve(); expect(child.send).toHaveBeenCalledOnce();
    child.emit('exit', 1); await owned.stop();
  });
  it('unconfirmed termination is bounded and never grants permission to clean fixtures', async () => {
    const { child, owned } = fixture(); const readiness = expect(owned.ready).rejects.toThrow('shutdown');
    child.send.mockImplementation(() => { throw new Error('Mock closed IPC'); });
    child.kill.mockImplementation(() => { throw new Error('Mock kill failure'); });
    const stopping = owned.stop(); const rejected = expect(stopping).rejects.toThrow('retain fixtures'); await readiness;
    await vi.advanceTimersByTimeAsync(50); await rejected;
    expect(owned.hasExited()).toBe(false); expect(child.kill).toHaveBeenCalledOnce();
    expect(owned.stop()).toBe(stopping);
    child.emit('exit', 1); expect(child.eventNames()).toEqual([]);
  });
  it('observed exit before readiness rejects, disposes listeners, and never kills another process', async () => {
    const { child, owned } = fixture(); const rejected = expect(owned.ready).rejects.toThrow('exited');
    child.emit('exit', 1); await rejected; await owned.stop();
    expect(child.kill).not.toHaveBeenCalled(); expect(child.send).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });
  it('shares shutdown if sending the shutdown request synchronously reports disconnect', async () => {
    const { child, owned } = fixture();
    child.emit('message', { type: 'ready', runId, host: '127.0.0.1', port: 45000 }); await owned.ready;
    child.send.mockImplementation(() => { child.emit('disconnect'); });
    const stopping = owned.stop(); await Promise.resolve();
    expect(child.send).toHaveBeenCalledOnce(); expect(owned.stop()).toBe(stopping);
    child.emit('exit', 0); await stopping; expect(child.kill).not.toHaveBeenCalled();
    expect(child.eventNames()).toEqual([]);
  });
  it('process errors use sanitized feedback and initiate shutdown', async () => {
    const { child, owned } = fixture(); const rejected = expect(owned.ready).rejects.toThrow('Owned child process failed.');
    child.emit('error', new Error('sensitive fake connection value')); await rejected;
    expect(child.send).toHaveBeenCalledOnce(); child.emit('exit', 1); await owned.stop();
  });
});

describe('ephemeral loopback binding with injected listeners only', () => {
  it('requests port zero and derives the origin from the actual socket address', async () => {
    const listen = vi.fn((_options, ready: () => void) => ready());
    const listener = Object.assign(new EventEmitter(), { listen, address: () => ({ address: '127.0.0.1', port: 49000 }) });
    await expect(bindLoopback(listener))
      .resolves.toBe('http://127.0.0.1:49000');
    expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0 }, expect.any(Function));
    expect(listener.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([null, 'pipe', { address: '0.0.0.0', port: 49000 }, { address: '127.0.0.1', port: 0 }])(
    'rejects unexpected socket address %#', async (address) => {
      const listener = Object.assign(new EventEmitter(), { listen: (_options: unknown, ready: () => void) => ready(), address: () => address });
      await expect(bindLoopback(listener)).rejects.toThrow('bound loopback');
    }
  );
  it('reports asynchronous bind errors without exposing their details', async () => {
    const listener = Object.assign(new EventEmitter(), { listen: vi.fn(), address: () => null });
    const rejected = expect(bindLoopback(listener)).rejects.toThrow('Loopback binding failed.');
    listener.emit('error', new Error('Mock sensitive detail')); await rejected;
    expect(listener.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds pending socket startup and removes its error listener', async () => {
    const listener = Object.assign(new EventEmitter(), { listen: vi.fn(), address: () => null });
    const rejected = expect(bindLoopback(listener, 100)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(listener.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
});
