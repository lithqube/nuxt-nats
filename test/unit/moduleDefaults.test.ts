import { describe, it, expect, vi, afterEach } from 'vitest'

const addServerImportsDir = vi.fn()
const addServerPlugin = vi.fn()
const addServerHandler = vi.fn()
const createResolver = vi.fn(() => ({ resolve: vi.fn((p: string) => `/fake/${p}`) }))

vi.mock('@nuxt/kit', () => ({
  addServerImportsDir,
  addServerPlugin,
  addServerHandler,
  createResolver,
  defineNuxtModule: <T>(def: T) => def,
}))

interface MockNuxt {
  options: {
    runtimeConfig: Record<string, any>
    _requiredModules?: Record<string, boolean>
  }
  hook: ReturnType<typeof vi.fn>
}

function makeMockNuxt(): MockNuxt {
  return {
    options: { runtimeConfig: {} },
    hook: vi.fn(),
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('module setup — userJwt default in runtimeConfig', () => {
  it('sets userJwt to "" in runtimeConfig when not specified in options', async () => {
    const mod = await import('../../src/module')
    const setup = (mod.default as any).setup

    const mockNuxt = makeMockNuxt()
    await setup({}, mockNuxt as any)

    expect(mockNuxt.options.runtimeConfig.nats).toBeDefined()
    expect(mockNuxt.options.runtimeConfig.nats.userJwt).toBe('')
  })

  it('passes through userJwt when specified in options', async () => {
    const mod = await import('../../src/module')
    const setup = (mod.default as any).setup

    const mockNuxt = makeMockNuxt()
    const jwt = 'eyJ0eXAiOiJqd3Q.signed.jwt-here'

    await setup({ userJwt: jwt }, mockNuxt as any)

    expect(mockNuxt.options.runtimeConfig.nats.userJwt).toBe(jwt)
  })

  it('passes through nkeySeed when specified in options', async () => {
    const mod = await import('../../src/module')
    const setup = (mod.default as any).setup

    const mockNuxt = makeMockNuxt()
    const seed = 'SUACSP3ZIAMH4SZJDQBJSKCJODPWI2OEGRRYHZEJ6YJPKXY4DPZ6XYZ'

    await setup({ nkeySeed: seed }, mockNuxt as any)

    expect(mockNuxt.options.runtimeConfig.nats.nkeySeed).toBe(seed)
  })

  it('sets nkeySeed to "" in runtimeConfig when not specified in options', async () => {
    const mod = await import('../../src/module')
    const setup = (mod.default as any).setup

    const mockNuxt = makeMockNuxt()
    await setup({}, mockNuxt as any)

    expect(mockNuxt.options.runtimeConfig.nats.nkeySeed).toBe('')
  })
})
