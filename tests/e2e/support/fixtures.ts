import { test as base } from '@playwright/test';

export function requireLiveRuntime(): never {
  throw new Error('Live E2E runtime is not implemented or enabled in Stage 2C.3A. Stage 2C.3B approval is required.');
}

// An automatic, non-browser fixture fails before a page/context/browser fixture
// could launch. No environment flag can enable a live adapter in this stage.
export const test = base.extend<{ offlineBoundary: void }>({
  offlineBoundary: [async ({ browserName }) => { void browserName; requireLiveRuntime(); }, { auto: true }]
});
