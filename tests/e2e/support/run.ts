import { requireLiveRuntime } from './fixtures.js';

// Intentionally no subprocess, environment loading, or database import. Keep
// accidental live invocation fail-closed even if a developer bypasses listing.
try { requireLiveRuntime(); }
catch { console.error('Live E2E execution is unavailable: Stage 2C.3B approval and implementation are required.'); process.exitCode = 1; }
