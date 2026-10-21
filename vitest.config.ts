import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: false,
    clearMocks: true,
    projects: [
      { test: { name: 'unit', environment: 'node',
        include: ['apps/api/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'packages/contracts/src/**/*.test.ts'] } },
      'apps/web/vitest.config.ts'
    ]
  }
});
