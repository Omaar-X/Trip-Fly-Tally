import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests need a live, migrated MySQL. They run separately via
    // `npm run test:integration` so `npm test` stays green without a database.
    exclude: ['test/integration/**'],
    // Stubs the audit writer, the one path that reached past the per-file
    // service mocks and wrote real rows into whatever database .env pointed at.
    // See test/setup.unit.ts.
    setupFiles: ['test/setup.unit.ts'],
  },
});
