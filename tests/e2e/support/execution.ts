export type LivePhase = 'preflight' | 'fixtures' | 'smoke' | 'full';
// Intentionally no approval flag, environment override, URL, or connector.
// Implementing a later phase requires a separately reviewed code change.
export function requireLivePhase(phase: LivePhase): never {
  void phase;
  throw new Error('Live harness execution is disabled in Stage 2C.3B1. Separate approval is required.');
}

const outcomes = new Set(['passed', 'failed', 'interrupted', 'timedOut', 'skipped']);
export function sanitizedResult(index: number, outcome: string): string {
  if (!Number.isSafeInteger(index) || index < 0 || !outcomes.has(outcome)) throw new Error('Invalid diagnostic metadata.');
  return JSON.stringify({ case: index, outcome });
}

// Deterministic response gate for an injected HTTP adapter. No URL, request
// body, cookie, response, or error content is retained in diagnostics.
export function responseGate() {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { waiting, release: () => release?.() };
}
