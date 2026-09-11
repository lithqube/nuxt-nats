import { describe, it, expect, vi, afterEach } from 'vitest'

const addServerPlugin = vi.fn()
const addTemplate = vi.fn((opts: { filename: string }) => ({ dst: `/proj/.nuxt/${opts.filename}` }))

vi.mock('@nuxt/kit', () => ({
  addServerImportsDir: vi.fn(),
  addServerPlugin,
  addServerHandler: vi.fn(),
  addTemplate,
  createResolver: () => ({ resolve: (p: string) => `/module/${p.replace(/^\.\//, '')}` }),
  defineNuxtModule: <T>(def: T) => def,
}))

/** A Nuxt 4 project with an app/ directory: srcDir is app/, the server directory is not. */
function nuxt4AppLayout() {
  return {
    options: {
      runtimeConfig: {},
      rootDir: '/proj',
      srcDir: '/proj/app',
      serverDir: '/proj/server',
    },
    hook: vi.fn(),
  }
}

async function generatedPluginSource(consumers: unknown[]): Promise<string> {
  const mod = await import('../../src/module')
  await (mod.default as any).setup({ consumers }, nuxt4AppLayout())
  const template = addTemplate.mock.calls.at(-1)![0] as unknown as { getContents: () => string }
  return template.getContents()
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * nats.consumers handler paths are documented as relative to server/. They used to be joined
 * onto `<srcDir>/server`, and in Nuxt 4 srcDir is `<rootDir>/app` whenever an app/ directory
 * exists, so `handler: 'workers/billing'` resolved to app/server/workers/billing and the build
 * could not find the file. The playground has no app/ directory, which hid it.
 */
describe('module setup — nats.consumers handler resolution', () => {
  it('resolves a relative handler against serverDir, not <srcDir>/server', async () => {
    const src = await generatedPluginSource([
      { stream: 'ORDERS', durable: 'billing', handler: 'workers/billing' },
    ])

    expect(src).toContain('from \'/proj/server/workers/billing\'')
    expect(src).not.toContain('/proj/app/server')
  })

  it('leaves an absolute handler path untouched', async () => {
    const src = await generatedPluginSource([
      { stream: 'ORDERS', durable: 'billing', handler: '/elsewhere/billing.ts' },
    ])

    expect(src).toContain('from \'/elsewhere/billing.ts\'')
  })

  it('registers the generated plugin after the connection plugin', async () => {
    addServerPlugin.mockClear()
    await generatedPluginSource([{ stream: 'ORDERS', durable: 'billing', handler: 'workers/billing' }])

    const plugins = addServerPlugin.mock.calls.map(call => call[0] as string)
    expect(plugins[0]).toContain('runtime/server/plugins/nats')
    expect(plugins[1]).toBe('/proj/.nuxt/nats-consumers.mjs')
  })
})
