import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['test/integration/**', 'node_modules/**'],
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
