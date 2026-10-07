import { describe, it, expect, vi, afterEach } from 'vitest'

const s = vi.hoisted(() => ({ details: false }))
vi.mock('nitropack/runtime', () => ({ useRuntimeConfig: () => ({ nats: { health: { details: s.details } } }) }))

const { default: handler } = await import('../../src/runtime/server/api/health.get')
const conn = await import('../../src/runtime/server/plugins/_connection')
const { CredentialManager, setCredentialManager } = await import('../../src/runtime/server/credentials/manager')

const call = () => (handler as unknown as (e: unknown) => Promise<Record<string, any>>)({})
const nc = { getServer: () => 'connect.ngs.global:4222', rtt: async () => 2_000_000 }

afterEach(() => {
  conn.setNatsConnection(undefined)
  conn.setAuthMode(undefined)
  setCredentialManager(undefined)
})

describe('health endpoint auth block', () => {
  it('reports disconnected without a connection', async () => {
    expect(await call()).toEqual({ status: 'disconnected', connected: false })
  })

  it('shows the auth mode only, by default', async () => {
    conn.setNatsConnection(nc as never)
    conn.setAuthMode('provider:infisical')
    setCredentialManager(new CredentialManager({ name: 'infisical', fetch: async () => ({ userJwt: 'a.b.c' }) }))
    s.details = false
    const res = await call()
    expect(res.auth).toEqual({ mode: 'provider:infisical' })
    expect(res.rttMs).toBe(2)
  })

  it('adds the provider status with health.details', async () => {
    conn.setNatsConnection(nc as never)
    conn.setAuthMode('provider:infisical')
    setCredentialManager(new CredentialManager({ name: 'infisical', fetch: async () => ({ userJwt: 'a.b.c' }) }))
    s.details = true
    const res = await call()
    expect(res.auth).toMatchObject({ mode: 'provider:infisical', provider: 'infisical', status: 'pending', lastErrorCode: null })
  })
})
