import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // A Nitro virtual module in a real build (src/providerTemplate.ts).
      '#nuxt-nats/credentials-provider': fileURLToPath(new URL('./test/fixtures/credentials/no-provider.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['test/integration/**', 'test/live/**', 'node_modules/**'],
    // Type-level tests: test/types/*.test-d.ts are type-checked, never executed.
    typecheck: {
      enabled: true,
      include: ['test/types/**/*.test-d.ts'],
      tsconfig: './test/types/tsconfig.json',
      // Only errors in the test files count. The src/ files they import are type-checked by
      // `npm run test:types` in the Nuxt-generated environment; checked in isolation here,
      // src/module.ts cannot see the Nitro hook types Nuxt adds.
      ignoreSourceErrors: true,
    },
  },
})
