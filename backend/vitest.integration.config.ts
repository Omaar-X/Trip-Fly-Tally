import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real, migrated database and mutate it, so
 * they run in a single file-sequential pass rather than in parallel workers.
 * Each file skips itself when no database is reachable.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
