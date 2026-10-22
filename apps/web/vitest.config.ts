import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import { defineProject } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(viteConfig, defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { name: 'web-components', environment: 'jsdom', include: ['src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'], clearMocks: true }
}));
