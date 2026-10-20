import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const schemaSrc = fileURLToPath(new URL('./packages/schema/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'uidna-schema': schemaSrc,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'packages/schema/test/**/*.test.ts', 'scripts/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          testTimeout: 1_200_000,
          hookTimeout: 300_000,
          fileParallelism: false,
          retry: 0,
        },
      },
    ],
  },
});
