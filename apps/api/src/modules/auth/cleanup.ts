type Cleanup = { cleanupExpired: (limit?: number) => Promise<number> };

// Started explicitly by the runtime server; creating an app never starts this task.
export function startSessionCleanup(service: Cleanup, reportFailure = () => console.error('Expired session cleanup failed.')) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = service.cleanupExpired(100).then(() => {}, () => {
      // Never forward database errors, connection URLs, or row values to the logger.
      try { reportFailure(); } catch { /* A logger failure must not create an unhandled rejection. */ }
    }).finally(() => { running = undefined; });
  }, 60_000);
  timer.unref();
  return async function stop() {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
