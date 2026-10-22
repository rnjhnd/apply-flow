const channelName = 'applyflow-auth';
const message = 'invalidate';

export type AuthCoordinationEvent = 'invalidate' | 'suspend' | 'resume';
export type AuthCoordination = {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  publish(): void;
  subscribe(listener: (event: AuthCoordinationEvent) => void): () => void;
  close(): void;
};

export function createBrowserCoordination(): AuthCoordination | undefined {
  try {
    if (typeof window === 'undefined' || !window.isSecureContext || typeof navigator === 'undefined' || !navigator.locks
      || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(channelName);
    const listeners = new Set<(event: AuthCoordinationEvent) => void>();
    const notify = (event: AuthCoordinationEvent) => { for (const listener of listeners) listener(event); };
    channel.onmessage = (event: MessageEvent<unknown>) => { if (event.data === message) notify('invalidate'); };
    const suspend = () => notify('suspend');
    const resume = (event: PageTransitionEvent) => { if (event.persisted) notify('resume'); };
    // BFCache/reload must discard local proof; neither event can cancel a server commit.
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    return {
      exclusive: (work) => navigator.locks.request(channelName, { mode: 'exclusive' }, work),
      publish() { try { channel.postMessage(message); } catch { /* Best effort, never authentication proof. */ } },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      close() {
        window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
        channel.close(); listeners.clear();
      }
    };
  } catch { return undefined; }
}
