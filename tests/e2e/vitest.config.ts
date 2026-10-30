import { defineConfig } from 'vitest/config';

/** End-to-end tests against the running local stack (`pnpm stack:up`). */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.e2e.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
