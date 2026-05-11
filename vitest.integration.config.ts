import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Run all integration suites in a single fork — containers are expensive
    pool: 'forks',
    singleFork: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
