import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// The connection plugin with a credentials provider: creds are fetched before connect, the
// client gets the manager's authenticator, changed creds reconnect, and auth errors refresh.
const s = vi.hoisted(() => ({
  fetchResults: [] as Array<() => unknown>,
  order: [] as string[],
  connectOpts: undefined as Record<string, unknown> | undefined,
  reconnect: undefined as unknown as ReturnType<typeof import('vitest').vi.fn>,
  config: {} as Record<string, unknown>,
}))

vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (fn: unknown) => fn,
  useRuntimeConfig: () => ({ nats: s.config }),
}))

vi.mock('#nuxt-nats/credentials-provider', () => ({
  default: {
    name: 'custom-test',
    fetch: async () => {
      s.order.push('fetch')
      const next = s.fetchResults.length > 1 ? s.fetchResults.shift()! : s.fetchResults[0]!
      return next()
    },
  },
}))

vi.mock('@nats-io/transport-node', () => ({
  connect: vi.fn(async (opts: Record<string, unknown>) => {
    s.order.push('connect')
    s.connectOpts = opts
    return { status: async function* () {}, reconnect: s.reconnect, getServer: () => 'x' }
  }),
  wsconnect: vi.fn(),
}))

vi.mock('@nats-io/jetstream', async importOriginal => ({
  ...await importOriginal<typeof import('@nats-io/jetstream')>(),
  jetstream: vi.fn(() => ({})),
  jetstreamManager: vi.fn(async () => ({})),
}))

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'ed25519-nkey' })}.${b64(claims)}.sig`
const exp = () => Math.floor(Date.now() / 1000) + 3600

async function boot() {
  vi.resetModules()
  const plugin = (await import('../../src/runtime/server/plugins/nats')).default as unknown as (app: unknown) => Promise<void>
  const manager = await import('../../src/runtime/server/credentials/manager')
  const conn = await import('../../src/runtime/server/plugins/_connection')
  const hooks = await import('../../src/runtime/server/utils/useNatsHooks')
  const nats = await import('../../src/runtime/server/plugins/nats')
  await plugin({ hooks: { hook: vi.fn() } })
  return { manager, conn, hooks, nats }
}

beforeEach(() => {
  s.fetchResults = [() => ({ userJwt: jwt({ exp: exp(), jti: 'a' }) })]
  s.order = []
  s.connectOpts = undefined
  s.reconnect = vi.fn(async () => {})
  s.config = { servers: ['nats://test:4222'], streams: [], health: {}, credentials: { provider: 'custom', refresh: { initTimeoutSec: 1 } } }
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(process, 'once').mockImplementation(() => process)
})

afterEach(async () => {
  const { getCredentialManager, setCredentialManager } = await import('../../src/runtime/server/credentials/manager')
  await getCredentialManager()?.dispose()
  setCredentialManager(undefined)
  vi.restoreAllMocks()
})

describe('connection plugin with a credentials provider', () => {
  it('fetches credentials before connecting and hands the client the manager authenticator', async () => {
    const { conn, manager } = await boot()
    expect(s.order).toEqual(['fetch', 'connect'])
    expect(typeof s.connectOpts!.authenticator).toBe('function')
    expect(s.connectOpts!.ignoreAuthErrorAbort).toBe(true)
    expect(conn.getAuthMode()).toBe('provider:custom-test')
    expect(manager.getCredentialManager()?.provider.name).toBe('custom-test')
    expect((s.connectOpts!.authenticator as (n: string) => { jwt: string })('n').jwt).toContain('.')
  })

  it('reconnects the live connection when the credentials change', async () => {
    s.fetchResults = [() => ({ userJwt: jwt({ exp: exp(), jti: 'a' }) }), () => ({ userJwt: jwt({ exp: exp(), jti: 'b' }) })]
    const { manager } = await boot()
    await manager.getCredentialManager()!.refreshNow('scheduled')
    expect(s.reconnect).toHaveBeenCalledOnce()
  })

  it('does not connect when no credentials arrive, and fires onConnectError', async () => {
    s.fetchResults = [() => {
      throw new Error('store down')
    }]
    vi.resetModules()
    const hooks = await import('../../src/runtime/server/utils/useNatsHooks')
    const onConnectError = vi.fn()
    hooks.useNatsHooks({ onConnectError })
    const plugin = (await import('../../src/runtime/server/plugins/nats')).default as unknown as (app: unknown) => Promise<void>
    await plugin({ hooks: { hook: vi.fn() } })
    const { getCredentialManager } = await import('../../src/runtime/server/credentials/manager')
    expect(s.order).toEqual(['fetch']) // initTimeoutSec 1: no retry fits, and no connect
    expect(onConnectError).toHaveBeenCalledOnce()
    expect(getCredentialManager()).toBeUndefined()
  })

  it('refreshes on an authorization or expiry error, not on a permissions violation', async () => {
    const { manager, nats } = await boot()
    const refresh = vi.spyOn(manager.getCredentialManager()!, 'refreshNow')
    nats.handleStatus({ type: 'error', error: new Error('Permissions Violation for Publish to "x"') } as never)
    expect(refresh).not.toHaveBeenCalled()
    nats.handleStatus({ type: 'error', error: new Error('User Authentication Expired') } as never)
    nats.handleStatus({ type: 'error', error: new Error('Authorization Violation') } as never)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledWith('auth-error')
  })

  it('uses the static settings when no provider is configured', async () => {
    s.config = { ...s.config, credentials: { provider: '' }, token: 'static-token' }
    const { conn, manager } = await boot()
    expect(s.order).toEqual(['connect'])
    expect(s.connectOpts!.token).toBe('static-token')
    expect(s.connectOpts!.ignoreAuthErrorAbort).toBeUndefined()
    expect(conn.getAuthMode()).toBe('token')
    expect(manager.getCredentialManager()).toBeUndefined()
  })

  it('fails boot with a clear error for a misconfigured provider', async () => {
    s.config = { ...s.config, credentials: { provider: 'synadia', synadia: { userId: '', token: '' } } }
    await boot()
    expect(s.order).toEqual([])
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.stringContaining('userId is required'))
  })
})
