import { defineConfig } from 'vitest/config'

// Live tests against a real Synadia Cloud account. Skipped unless SYNADIA_LIVE=1 and
// SYNADIA_CREDS_FILE are set; see test/live/cloud.test.ts.
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
