import { describe, it, expect, vi, afterEach } from 'vitest'

const addServerImportsDir = vi.fn()
const addNitroPlugin = vi.fn()
const addServerHandler = vi.fn()
const createResolver = vi.fn(() => ({ resolve: vi.fn((p: string) => `/fake/${p}`) }))

vi.mock('@nuxt/kit', () => ({
  addServerImportsDir,
  addNitroPlugin,
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
  vi.restoreAllMocks()
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

describe('module setup — Synadia Cloud and creds', () => {
  async function run(options: Record<string, unknown>, dev = false) {
    const mod = await import('../../src/module')
    const mockNuxt = makeMockNuxt()
    ;(mockNuxt.options as any).dev = dev
    await (mod.default as any).setup(options, mockNuxt as any)
    return mockNuxt.options.runtimeConfig.nats
  }

  it('defaults to a local server', async () => {
    const nats = await run({})
    expect(nats.servers).toEqual(['nats://localhost:4222'])
    expect(nats.wsServers).toEqual([])
  })

  it('synadia: true fills in the global Cloud endpoints', async () => {
    const nats = await run({ synadia: true })
    expect(nats.servers).toEqual(['tls://connect.ngs.global'])
    expect(nats.wsServers).toEqual(['wss://connect.ngs.global:443'])
  })

  it('synadia.region selects a regional endpoint', async () => {
    const nats = await run({ synadia: { region: 'eu' } })
    expect(nats.servers).toEqual(['tls://eu.geo.ngs.global'])
  })

  it('explicit servers win over the Cloud preset', async () => {
    const nats = await run({ synadia: true, servers: ['tls://leaf.internal:7422'] })
    expect(nats.servers).toEqual(['tls://leaf.internal:7422'])
    expect(nats.wsServers).toEqual(['wss://connect.ngs.global:443'])
  })

  it('pre-seeds creds, credsFile and name so NUXT_NATS_* env vars map at runtime', async () => {
    const nats = await run({})
    expect(nats.creds).toBe('')
    expect(nats.credsFile).toBe('')
    expect(nats.name).toBe('')
  })

  it('warns on a build when a credential is set in nuxt.config, without printing it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run({ creds: 'SECRET-CREDS', token: 'SECRET-TOKEN' })
    expect(warnSpy).toHaveBeenCalledOnce()
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain('nats.creds, nats.token')
    expect(msg).toContain('NUXT_NATS_CREDS, NUXT_NATS_TOKEN')
    expect(msg).not.toContain('SECRET')
  })

  it('does not warn in dev or when only a creds file path is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await run({ creds: 'SECRET-CREDS' }, true)
    await run({ credsFile: '/run/secrets/nats.creds' })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
