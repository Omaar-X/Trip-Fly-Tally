import { defineConfig, mergeConfig } from 'vite';
import { defineConfig as defineVitestConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineVitestConfig({
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      globals: false,
    },
  })
);
