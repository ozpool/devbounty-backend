import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests sequentially to avoid port/db conflicts between integration suites
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globals: false,
    environment: 'node',
    // Each test file gets its own isolated module graph
    isolate: true,
  },
});
