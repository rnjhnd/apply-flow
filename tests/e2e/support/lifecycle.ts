import type { EventEmitter } from 'node:events';
import { z } from 'zod';

export type OwnedChild = Pick<EventEmitter, 'on' | 'off'> & {
  send(message: { type: 'shutdown'; runId: string }): void;
  kill(): void;
};
const readySchema = z.strictObject({ type: z.literal('ready'), runId: z.uuid(),
  host: z.literal('127.0.0.1'), port: z.number().int().min(1).max(65535) });

// No spawn implementation is supplied in Stage A. Only the returned owned
// handle can be signalled; never look up/kill a PID, process group, or port owner.
export function ownChild(spawn: () => OwnedChild, runId: string,
  timing = { startupMs: 30_000, graceMs: 2_000, exitMs: 2_000 }) {
  z.uuid().parse(runId);
  const child = spawn();
  let exited = false;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let resolveExit: () => void = () => undefined;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let resolveReady: (value: { origin: string }) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let settled = false;
  let failure: Error | undefined;
  const ready = new Promise<{ origin: string }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  function reject(message: string) {
    failure ??= new Error(message);
    if (!settled) { settled = true; clearTimeout(startup); rejectReady(failure); }
  }
  function onMessage(value: unknown) {
    if (settled || failure || stopping) return;
    const parsed = readySchema.safeParse(value);
    if (!parsed.success || parsed.data.runId !== runId) {
      reject('Unexpected child readiness identity.'); void stop().catch(() => undefined); return;
    }
    settled = true;
    clearTimeout(startup);
    resolveReady({ origin: `http://127.0.0.1:${parsed.data.port}` });
  }
  function onExit() {
    exited = true; resolveExit(); reject('Owned child exited.');
    child.off('message', onMessage); child.off('exit', onExit);
    child.off('disconnect', onDisconnect); child.off('error', onError);
    clearTimeout(startup);
  }
  function onDisconnect() { reject('Owned child IPC disconnected.'); void stop().catch(() => undefined); }
  function onError() { reject('Owned child process failed.'); void stop().catch(() => undefined); }
  const startup = setTimeout(() => {
    reject('Owned child readiness timed out.'); void stop().catch(() => undefined);
  }, timing.startupMs);
  child.on('message', onMessage); child.on('exit', onExit);
  child.on('disconnect', onDisconnect); child.on('error', onError);

  async function waitExit(ms: number): Promise<boolean> {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exit.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    })]); } finally { clearTimeout(timer); }
  }
  function stop(): Promise<void> {
    // Admission closes synchronously, before the shutdown microtask. The shared
    // promise is still published before invoking any channel method.
    stopping = true;
    reject('Owned child shutdown requested.');
    // Publish ownership before invoking an injected/channel method: send() may
    // synchronously report disconnect, which must join this same shutdown.
    stopPromise ??= Promise.resolve().then(async () => {
      if (exited) return;
      try { child.send({ type: 'shutdown', runId }); } catch { /* IPC may already be closed. */ }
      if (await waitExit(timing.graceMs)) return;
      // Exit can arrive after the timeout wins but before this continuation.
      if (exited) return;
      try { child.kill(); } catch { /* Still require observed exit. */ }
      if (!await waitExit(timing.exitMs)) throw new Error('Child exit unconfirmed; retain fixtures for manual review.');
    });
    return stopPromise;
  }
  return { ready, stop, hasExited: () => exited, isHealthy: () => settled && !failure && !exited && !stopping };
}

export type LoopbackListener = Pick<EventEmitter, 'once' | 'off'> & {
  listen(options: { host: '127.0.0.1'; port: 0 }, ready: () => void): void;
  address(): { address: string; port: number } | string | null;
};
export function bindLoopback(listener: LoopbackListener, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail('Loopback binding timed out.'), timeoutMs);
    function cleanup() { clearTimeout(timeout); listener.off('error', onError); }
    function fail(message: string) { cleanup(); reject(new Error(message)); }
    function onError() { fail('Loopback binding failed.'); }
    listener.once('error', onError);
    try { listener.listen({ host: '127.0.0.1', port: 0 }, () => {
      cleanup();
      const address = listener.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1'
        || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
        reject(new Error('Unexpected bound loopback address.')); return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    }); } catch { fail('Loopback binding failed.'); }
  });
}
