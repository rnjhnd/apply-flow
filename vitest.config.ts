import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'packages/contracts/src/**/*.test.ts'],
    passWithNoTests: false,
    clearMocks: true
  }
});
