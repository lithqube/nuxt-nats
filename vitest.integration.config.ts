import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Run the integration suites one file at a time — containers are expensive.
    // Vitest 4 removed `singleFork`, which had been silently ignored since the upgrade.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
