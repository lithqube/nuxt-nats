// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

// Run `npx @eslint/config-inspector` to inspect the resolved config interactively
export default createConfigForNuxt({
  features: {
    // Rules for module authors
    tooling: true,
    // Rules for formatting
    stylistic: true,
  },
  dirs: {
    src: [
      './playground',
    ],
  },
})
  .append(
    // Test files need `any` for mocking NATS internals (consume iterators, JsMsg,
    // ConsumerInfo) and use single-line patterns that style rules dislike.
    {
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': ['error', {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^(_|vi$)',
        }],
        '@stylistic/max-statements-per-line': ['error', { max: 2 }],
        'no-empty': ['error', { allowEmptyCatch: true }],
      },
    },
  )
