import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { composeChild } from './child-runtime.js';
import { createChildRecorder } from './child-protocol.js';
import { env, sql, owner, memoryIo, inspection } from './b1-fakes.js';

describe('B1 test child composition with fake connection, HTTP listener, and application', () => {
  function fixture() {
    const review = vi.fn(); const recorder = createChildRecorder(owner, memoryIo(), async () => undefined, review);
    const connection = { inspect: vi.fn(async () => inspection()), close: vi.fn(async () => undefined) };
    const listener = Object.assign(new EventEmitter(), {
      listen: vi.fn((_options, callback: () => void) => { callback(); }),
      address: () => ({ address: '127.0.0.1', port: 49124 }), close: vi.fn(async () => undefined)
    });
    const dependencies = { connect: vi.fn(async () => connection), listener: vi.fn(() => listener),
      attach: vi.fn(async () => undefined), review };
    return { recorder, connection, listener, dependencies, review };
  }
  it('preflights before loopback binding, derives the trusted origin, and shares child shutdown', async () => {
    const f = fixture(); const child = await composeChild(env, sql, f.recorder, f.dependencies);
    expect(f.listener.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0 }, expect.any(Function));
    expect(child.origin).toBe('http://127.0.0.1:49124'); expect(child.config).toEqual({ nodeEnv: 'test', appOrigin: child.origin, allowLocalRegistration: true });
    expect(f.connection.inspect.mock.invocationCallOrder[0]!).toBeLessThan(f.dependencies.listener.mock.invocationCallOrder[0]!);
    expect(f.dependencies.attach).toHaveBeenCalledWith(f.connection, f.listener, child.config, { serveFrontend: true });
    const stopping = child.stop(); expect(child.stop()).toBe(stopping); expect(f.recorder.state()).toBe('quiescing');
    await stopping; expect(f.listener.close).toHaveBeenCalledOnce(); expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.recorder.state()).toBe('sealed'); expect(f.review).not.toHaveBeenCalled();
  });
  it('never constructs a listener on environment or database preflight failure', async () => {
    const f = fixture(); await expect(composeChild({ ...env, NODE_ENV: 'production' }, sql, f.recorder, f.dependencies)).rejects.toThrow();
    expect(f.dependencies.connect).not.toHaveBeenCalled(); expect(f.dependencies.listener).not.toHaveBeenCalled();
    f.connection.inspect.mockResolvedValue({ ...inspection(), identity: { ...inspection().identity, database: 'wrong' } });
    await expect(composeChild(env, sql, f.recorder, f.dependencies)).rejects.toThrow(); expect(f.connection.close).toHaveBeenCalledOnce();
    expect(f.dependencies.listener).not.toHaveBeenCalled();
  });
  it('closes supplied resources and retains review evidence after attach failure', async () => {
    const f = fixture(); f.dependencies.attach.mockRejectedValue(new Error('private application details'));
    await expect(composeChild(env, sql, f.recorder, f.dependencies)).rejects.toThrow(/^Child composition requires review\.$/);
    expect(f.listener.close).toHaveBeenCalledOnce(); expect(f.connection.close).toHaveBeenCalledOnce(); expect(f.review).toHaveBeenCalledOnce();
  });
  it('does not publish a seal if database close cannot confirm settlement', async () => {
    const f = fixture(); const child = await composeChild(env, sql, f.recorder, f.dependencies);
    f.connection.close.mockRejectedValue(new Error('unsettled driver'));
    await expect(child.stop()).rejects.toThrow('review'); expect(f.recorder.state()).toBe('review');
  });
});
