import { describe, it, expect, vi, afterEach } from 'vitest'

const s = vi.hoisted(() => ({ api: { url: '', token: 'sat_cfg' } }))
vi.mock('nitropack/runtime', () => ({ useRuntimeConfig: () => ({ nats: { synadiaApi: s.api } }) }))

const { useSynadiaCloud } = await import('../../src/runtime/server/utils/useSynadiaCloud')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSynadiaCloud', () => {
  it('uses the runtime config token and caches the client', async () => {
    const fetch = vi.fn(async () => new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetch)
    const a = useSynadiaCloud()
    expect(useSynadiaCloud()).toBe(a)
    await a.listTeams()
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer sat_cfg')
  })

  it('lets options override the config, with a new client', async () => {
    const fetch = vi.fn(async () => new Response('{"items":[]}'))
    vi.stubGlobal('fetch', fetch)
    const c = useSynadiaCloud({ token: 'sat_opt', apiUrl: 'https://cp.internal/api' })
    expect(c).not.toBe(useSynadiaCloud())
    await c.listTeams()
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://cp.internal/api/core/beta/teams')
  })

  it('throws without a token', () => {
    s.api = { url: '', token: '' }
    expect(() => useSynadiaCloud()).toThrow(/a token is required/)
  })
})
