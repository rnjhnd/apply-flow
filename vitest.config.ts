import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/src/**/*.test.ts', 'packages/contracts/src/**/*.test.ts'],
    passWithNoTests: false,
    clearMocks: true
  }
});
